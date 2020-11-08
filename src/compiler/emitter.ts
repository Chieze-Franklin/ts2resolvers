import _ from 'lodash';

import * as Types from './types';
import { ReferenceNode } from './types';

// tslint:disable-next-line
// https://raw.githubusercontent.com/sogko/graphql-shorthand-notation-cheat-sheet/master/graphql-shorthand-notation-cheat-sheet.png
export default class Emitter {
    renames: {[key: string]: string} = {};
    enumNames: string[] = [];
    scalarNames: string[] = [];

    constructor(private types: Types.TypeMap) {
        this.types = <Types.TypeMap>_.omitBy(types, (node, name) => this._preprocessNode(node, name!));
    }

    emitAll(stream: NodeJS.WritableStream) {
        stream.write('\n');
        _.each(this.types, (node, name) => this.emitTopLevelNode(node, name!, stream));
    }

    emitTopLevelNode(node: Types.Node, name: Types.SymbolName, stream: NodeJS.WritableStream) {
        let content;
        if (node.type === 'alias') {
          content = this._emitAlias(node, name);
        } else if (node.type === 'interface') {
            content = this._emitInterface(node, name);
        } else if (node.type === 'enum') {
          content = this._emitEnum(node, name);
        } else {
            throw new Error(`Can't emit ${node.type} as a top level node`);
        }
        stream.write(`${content}\n\n`);
    }

    _collectMembers = (node: Types.InterfaceNode|Types.LiteralObjectNode): Types.PropertyNode[] => {
        let members: Types.Node[] = [];
        if (node.type === 'literal object') {
            members = node.members;
        } else {
            const seenProps = new Set<Types.SymbolName>();
            let interfaceNode: Types.InterfaceNode|null;
            interfaceNode = node;
        
            // loop through this interface and any super-interfaces
            while (interfaceNode) {
                for (const member of interfaceNode.members) {
                    if (seenProps.has(member.name)) continue;
                    seenProps.add(member.name);
                    members.push(member);
                }
                if (interfaceNode.inherits.length > 1) {
                    throw new Error(`No support for multiple inheritence: ${JSON.stringify(interfaceNode.inherits)}`);
                } else if (interfaceNode.inherits.length === 1) {
                    const supertype: Types.Node = this.types[interfaceNode.inherits[0]];
                    if (supertype.type !== 'interface') {
                        throw new Error(`Expected supertype to be an interface node: ${supertype}`);
                    }
                    interfaceNode = supertype;
                } else {
                    interfaceNode = null;
                }
            }
        }
    
        for (const member of members) {
            if (member.type !== 'property') {
                throw new Error(`Expected members to be properties; got ${member.type}`);
            }
        }
        return members as Types.PropertyNode[];
    }

    _costHelper(node: Types.ComplexNode) {
        const costExists = this._getDocTag(node, 'cost');
        if (costExists) {
            return ` @cost${costExists.substring(5)}`;
        }
        return '';
    }

    _directiveHelper(node: Types.ComplexNode) {
        const directives = this._getDocTags(node, 'directive')
            .map(tag => ` @${tag.substring(10)}`)
            .join('');
        return directives;
    }

    _emitAlias(node: Types.AliasNode, name: Types.SymbolName): string {
        if (this._isPrimitive(node.target)) {
            this.scalarNames.push(this._name(name));
            return `scalar ${this._name(name)}`;
        } else if (node.target.type === 'reference') {
            return `union ${this._name(name)} = ${this._name(node.target.target)}`;
        } else if (node.target.type === 'union') {
            return this._emitUnion(node.target, name);
        } else {
            throw new Error(`Can't serialize ${JSON.stringify(node.target)} as an alias`);
        }
    }

    _emitEnum(node:Types.EnumNode, name:Types.SymbolName):string {
        this.enumNames.push(this._name(name));
        return `enum ${this._name(name)} {\n${this._indent(node.values)}\n}`;
    }

    _emitExpression = (node: Types.Node): string => {
        if (!node) {
            return '';
        } else if (node.type === 'string') {
            return 'String'; // TODO: ID annotation
        } else if (node.type === 'number') {
            return 'Float'; // TODO: Int/Float annotation
        } else if (node.type === 'boolean') {
            return 'Boolean';
        } else if (node.type === 'reference') {
            return this._name(node.target);
        } else if (node.type === 'array') {
            return `[${node.elements.map(this._emitExpression).join(' | ')}]`;
        } else if (node.type === 'literal object' || node.type === 'interface') {
            return _(this._collectMembers(node))
                .map((member:Types.PropertyNode) => {
                    return `${this._name(member.name)}: ${this._emitExpression(member.signature)}`;
                })
                .join(', ');
        } else {
            throw new Error(`Can't serialize ${node.type} as an expression`);
        }
    }

    _emitInterface(node: Types.InterfaceNode, name: Types.SymbolName): string {
        // GraphQL expects denormalized type interfaces
        const members = <Types.Node[]>_(this._transitiveInterfaces(node))
            .map((i: Types.InterfaceNode) => i.members)
            .flatten()
            .uniqBy('name')
            .sortBy('name')
            .value();
    
        // GraphQL can't handle empty types or interfaces, but we also don't want
        // to remove all references (complicated).
        if (!members.length) {
            members.push({
                type: 'property',
                name: '_placeholder',
                signature: { type: 'boolean' },
            });
        }
    
        const properties = _.map(members, (member) => {
            if (member.type === 'method') {
                let parameters = '';
                if (_.size(member.parameters) > 1) {
                    throw new Error(`Methods can have a maximum of 1 argument`);
                } else if (_.size(member.parameters) === 1) {
                    let argType = _.values(member.parameters)[0] as Types.Node;
                    if (argType.type === 'reference') {
                        argType = this.types[argType.target];
                    }
                    parameters = `(${this._emitExpression(argType)})`;
                }
                const returnType = this._emitExpression(member.returns);
                const costDecorator = this._costHelper(member);
                const directives = this._directiveHelper(member);
                return `${this._name(member.name)}${parameters}: ${returnType}${costDecorator}${directives}`;
            } else if (member.type === 'property') {
                // TODO: if property is a reference to the plural of a type, create the appropriate params (where, orderBy, skip...)
                const costDecorator = this._costHelper(member);
                const directives = this._directiveHelper(member);
                const mark = member.optional ? '' : '!';
                return `${this._name(member.name)}: ${this._emitExpression(member.signature)}${mark}${costDecorator}${directives}`;
            } else {
                throw new Error(`Can't serialize ${member.type} as a property of an interface`);
            }
        });
    
        if (this._getDocTag(node, 'schema')) {
            return `schema {\n${this._indent(properties)}\n}`;
        } else if (this._getDocTag(node, 'input')) {
            return `input ${this._name(name)} {\n${this._indent(properties)}\n}`;
        }
    
        if (node.concrete) {
            // If tagged with a "key" graphql tag, add the @key annotation for federation
            const federationDecorator = this._getDocTags(node, 'key')
                .map(tag => ` @key(fields: "${tag.substring(4)}")`)
                .join('');
            const costDecorator = this._costHelper(node);
            const directives = this._directiveHelper(node);

            let result = `type ${this._name(name)}${federationDecorator}${costDecorator}${directives} {\n${this._indent(properties)}\n}`;

            if (name.toLowerCase() !== 'query' && name.toLowerCase() !== 'mutation'&& !name.startsWith('_')) {
                // TODO: consider putting these extended emissions under a boolean flag so it can be turned off by user

                // batch payload
                result = `${result}\n\n${this._emitInterfaceBatchPayload(node, name)}`;

                // create input
                result = `${result}\n\n${this._emitInterfaceCreateInput(node, name)}`;

                // create many input
                result = `${result}\n\n${this._emitInterfaceCreateManyInput(node, name)}`;

                // create one input
                result = `${result}\n\n${this._emitInterfaceCreateOneInput(node, name)}`;

                // order by input
                result = `${result}\n\n${this._emitInterfaceOrderByInput(node, name)}`;

                // update input
                result = `${result}\n\n${this._emitInterfaceUpdateInput(node, name)}`;

                // update many input
                result = `${result}\n\n${this._emitInterfaceUpdateManyInput(node, name)}`;

                // update many mutation input
                result = `${result}\n\n${this._emitInterfaceUpdateManyMutationInput(node, name)}`;

                // update one input
                result = `${result}\n\n${this._emitInterfaceUpdateOneInput(node, name)}`;

                // where input
                result = `${result}\n\n${this._emitInterfaceWhereInput(node, name)}`;

                // where unique input
                result = `${result}\n\n${this._emitInterfaceWhereUniqueInput(node, name)}`;

                // query extension
                result = `${result}\n\n${this._emitQueryExtension(node, name)}`;

                // mutation extension
                result = `${result}\n\n${this._emitMutationExtension(node, name)}`;
            }

            return result;
        }
    
        let result = `interface ${this._name(name)} {\n${this._indent(properties)}\n}`;

        const fragmentDeclaration = this._getDocTag(node, 'fragment');
        if (fragmentDeclaration) {
          result = `${result}\n\n${fragmentDeclaration} {\n${this._indent(members.map((m: any) => m.name))}\n}`;
        }
    
        return result;
    }

    _emitInterfaceBatchPayload(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const properties = [
            `count: Long`
        ];
    
        return `type ${name}BatchPayload {\n${this._indent(properties)}\n}`;
    }

    _emitInterfaceCreateInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        // GraphQL expects denormalized type interfaces
        const members = <Types.Node[]>_(this._transitiveInterfaces(node))
            .map((i: Types.InterfaceNode) => i.members)
            .flatten()
            .uniqBy('name')
            .sortBy('name')
            .value();
    
        // GraphQL can't handle empty types or interfaces, but we also don't want
        // to remove all references (complicated).
        if (!members.length) {
            members.push({
                type: 'property',
                name: '_placeholder',
                signature: { type: 'boolean' },
            });
        }
    
        let properties = _.map(members, (member) => {
            if (member.type === 'method') {
                if (_.size(member.parameters) === 0) {
                    return this._emitInterfaceCreateInputClauses(member.returns, member.name, member.optional);
                }
                
                return '';
            } else if (member.type === 'property') {
                // TODO: if property is a reference to the plural of a type, create the appropriate clauses
                return this._emitInterfaceCreateInputClauses(member.signature, member.name, member.optional);
            } else {
                throw new Error(`Can't serialize ${member.type} as a property of an interface`);
            }
        });
    
        return `input ${name}CreateInput {\n${this._indent(properties.filter(p => !!(p)))}\n}`;
    }

    _emitInterfaceCreateInputClauses = (node: Types.Node, name: Types.SymbolName, optional: boolean = false): string => {
        const expression = this._emitExpression(node);
        const mark = optional ? '' : '!';

        if (!node) {
            return '';
        } else if (expression === 'ID') {
            return `${name}: ${expression}`; // always optional, so can't end with "!"
        } else if (node.type === 'alias') {
            return this._emitInterfaceCreateInputClauses(node.target, name);
        } else if (node.type === 'array') {
            if (node.elements[0].type === 'reference') {
                return `${name}: ${node.elements[0].target}CreateManyInput${mark}`;
            } else {
                return `${name}: ${expression}${mark}`;
            }
        } else if (node.type === 'reference') {
            if (this.enumNames.includes(expression) || this.scalarNames.includes(expression)) {
                return `${name}: ${expression}${mark}`;
            } else {
                return `${name}: ${node.target}CreateOneInput${mark}`;
            }
        } else {
            return `${name}: ${expression}${mark}`;
        }
    }

    _emitInterfaceCreateManyInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const properties = [
            `connect: [${name}WhereUniqueInput!]`
        ];
    
        return `input ${name}CreateManyInput {\n${this._indent(properties)}\n}`;
    }

    _emitInterfaceCreateOneInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const properties = [
            `connect: ${name}WhereUniqueInput`
        ];
    
        return `input ${name}CreateOneInput {\n${this._indent(properties)}\n}`;
    }

    _emitInterfaceOrderByInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        // GraphQL expects denormalized type interfaces
        const members = <Types.Node[]>_(this._transitiveInterfaces(node))
            .map((i: Types.InterfaceNode) => i.members)
            .flatten()
            .uniqBy('name')
            .sortBy('name')
            .value();
    
        // GraphQL can't handle empty types or interfaces, but we also don't want
        // to remove all references (complicated).
        if (!members.length) {
            members.push({
                type: 'property',
                name: '_placeholder',
                signature: { type: 'boolean' },
            });
        }
    
        let properties = _.map(members, (member) => {
            if (member.type === 'method') {
                if (_.size(member.parameters) === 0) {
                    return [`${member.name}_ASC`, `${member.name}_DESC`];
                }
                
                return [];
            } else if (member.type === 'property') {
                // TODO: if property is a reference to the plural of a type, create the appropriate clauses
                return [`${member.name}_ASC`, `${member.name}_DESC`];
            } else {
                throw new Error(`Can't serialize ${member.type} as a property of an interface`);
            }
        });
    
        return `enum ${name}OrderByInput {\n${this._indent(properties.flat())}\n}`;
    }

    _emitInterfaceUpdateInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        // GraphQL expects denormalized type interfaces
        const members = <Types.Node[]>_(this._transitiveInterfaces(node))
            .map((i: Types.InterfaceNode) => i.members)
            .flatten()
            .uniqBy('name')
            .sortBy('name')
            .value();
    
        // GraphQL can't handle empty types or interfaces, but we also don't want
        // to remove all references (complicated).
        if (!members.length) {
            members.push({
                type: 'property',
                name: '_placeholder',
                signature: { type: 'boolean' },
            });
        }
    
        let properties = _.map(members, (member) => {
            if (member.type === 'method') {
                if (_.size(member.parameters) === 0) {
                    return this._emitInterfaceUpdateInputClauses(member.returns, member.name);
                }
                
                return '';
            } else if (member.type === 'property') {
                // TODO: if property is a reference to the plural of a type, create the appropriate clauses
                return this._emitInterfaceUpdateInputClauses(member.signature, member.name);
            } else {
                throw new Error(`Can't serialize ${member.type} as a property of an interface`);
            }
        });
    
        return `input ${name}UpdateInput {\n${this._indent(properties.filter(p => !!(p)))}\n}`;
    }

    _emitInterfaceUpdateInputClauses = (node: Types.Node, name: Types.SymbolName): string => {
        const expression = this._emitExpression(node);

        if (!node) {
            return '';
        } else if (expression === 'ID') {
            return ''; // can't update ID
        } else if (node.type === 'alias') {
            return this._emitInterfaceUpdateInputClauses(node.target, name);
        } else if (node.type === 'array') {
            if (node.elements[0].type === 'reference') {
                return `${name}: ${node.elements[0].target}UpdateManyInput`;
            } else {
                return `${name}: ${expression}`;
            }
        } else if (node.type === 'reference') {
            if (this.enumNames.includes(expression) || this.scalarNames.includes(expression)) {
                return `${name}: ${expression}`;
            } else {
                return `${name}: ${node.target}UpdateOneInput`;
            }
        } else {
            return `${name}: ${expression}`;
        }
    }

    _emitInterfaceUpdateManyInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const properties = [
            `connect: [${name}WhereUniqueInput!]`
        ];
    
        return `input ${name}UpdateManyInput {\n${this._indent(properties)}\n}`;
    }

    _emitInterfaceUpdateManyMutationInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        // GraphQL expects denormalized type interfaces
        const members = <Types.Node[]>_(this._transitiveInterfaces(node))
            .map((i: Types.InterfaceNode) => i.members)
            .flatten()
            .uniqBy('name')
            .sortBy('name')
            .value();
    
        // GraphQL can't handle empty types or interfaces, but we also don't want
        // to remove all references (complicated).
        if (!members.length) {
            members.push({
                type: 'property',
                name: '_placeholder',
                signature: { type: 'boolean' },
            });
        }
    
        let properties = _.map(members, (member) => {
            if (member.type === 'method') {
                if (_.size(member.parameters) === 0) {
                    return this._emitInterfaceUpdateManyMutationInputClauses(member.returns, member.name);
                }
                
                return '';
            } else if (member.type === 'property') {
                // TODO: if property is a reference to the plural of a type, create the appropriate clauses
                return this._emitInterfaceUpdateManyMutationInputClauses(member.signature, member.name);
            } else {
                throw new Error(`Can't serialize ${member.type} as a property of an interface`);
            }
        });
    
        return `input ${name}UpdateManyMutationInput {\n${this._indent(properties.filter(p => !!(p)))}\n}`;
    }

    _emitInterfaceUpdateManyMutationInputClauses = (node: Types.Node, name: Types.SymbolName): string => {
        const expression = this._emitExpression(node);

        if (!node) {
            return '';
        } else if (expression === 'ID') {
            return ''; // can't update ID
        } else if (node.type === 'alias') {
            return this._emitInterfaceUpdateInputClauses(node.target, name);
        } else if (node.type === 'array') {
            return ''; // can't update array on many objects simultaneously
        } else if (node.type === 'reference') {
            if (this.enumNames.includes(expression) || this.scalarNames.includes(expression)) {
                return `${name}: ${expression}`;
            } else {
                return ''; // can't update reference on many objects simultaneously
            }
        } else {
            return `${name}: ${expression}`;
        }
    }

    _emitInterfaceUpdateOneInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const properties = [
            `connect: ${name}WhereUniqueInput`
        ];
    
        return `input ${name}UpdateOneInput {\n${this._indent(properties)}\n}`;
    }

    _emitInterfaceWhereInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        // GraphQL expects denormalized type interfaces
        const members = <Types.Node[]>_(this._transitiveInterfaces(node))
            .map((i: Types.InterfaceNode) => i.members)
            .flatten()
            .uniqBy('name')
            .sortBy('name')
            .value();
    
        // GraphQL can't handle empty types or interfaces, but we also don't want
        // to remove all references (complicated).
        if (!members.length) {
            members.push({
                type: 'property',
                name: '_placeholder',
                signature: { type: 'boolean' },
            });
        }
    
        let properties = _.map(members, (member) => {
            if (member.type === 'method') {
                if (_.size(member.parameters) === 0) {
                    return this._emitInterfaceWhereInputClauses(member.returns, member.name);
                }
                
                return [];
            } else if (member.type === 'property') {
                // TODO: if property is a reference to the plural of a type, create the appropriate clauses
                return this._emitInterfaceWhereInputClauses(member.signature, member.name);
            } else {
                throw new Error(`Can't serialize ${member.type} as a property of an interface`);
            }
        });
        properties.push([
            `AND: [${name}WhereInput!]`,
            `OR: [${name}WhereInput!]`,
            `NOT: [${name}WhereInput!]`
        ]);
    
        return `input ${name}WhereInput {\n${this._indent(properties.flat())}\n}`;
    }

    _emitInterfaceWhereInputClauses = (node: Types.Node, name: Types.SymbolName): string[] => {
        const expression = this._emitExpression(node);

        if (!node) {
            return [];
        } else if (node.type === 'alias') {
            return this._emitInterfaceWhereInputClauses(node.target, name);
        } else if (node.type === 'string' || expression === 'ID') {
            return [
                `${name}: ${expression}`,
                `${name}_not: ${expression}`,
                `${name}_in: [${expression}!]`,
                `${name}_not_in: [${expression}!]`,
                `${name}_lt: ${expression}`,
                `${name}_lte: ${expression}`,
                `${name}_gt: ${expression}`,
                `${name}_gte: ${expression}`,
                `${name}_contains: ${expression}`,
                `${name}_not_contains: ${expression}`,
                `${name}_starts_with: ${expression}`,
                `${name}_not_starts_with: ${expression}`,
                `${name}_ends_with: ${expression}`,
                `${name}_not_ends_with: ${expression}`,
            ];
        } else if (node.type === 'number') {  // TODO: Int/Float annotation
            return [
                `${name}: ${expression}`,
                `${name}_not: ${expression}`,
                `${name}_in: [${expression}!]`,
                `${name}_not_in: [${expression}!]`,
                `${name}_lt: ${expression}`,
                `${name}_lte: ${expression}`,
                `${name}_gt: ${expression}`,
                `${name}_gte: ${expression}`,
            ];
        } else if (node.type === 'boolean') {
            return [
                `${name}: ${expression}`,
                `${name}_not: ${expression}`,
                `${name}_in: [${expression}!]`,
                `${name}_not_in: [${expression}!]`,
            ];
        } else if (expression === 'Date' || expression === 'DateTime') {
            return [
                `${name}: ${expression}`,
                `${name}_not: ${expression}`,
                `${name}_in: [${expression}!]`,
                `${name}_not_in: [${expression}!]`,
                `${name}_lt: ${expression}`,
                `${name}_lte: ${expression}`,
                `${name}_gt: ${expression}`,
                `${name}_gte: ${expression}`,
            ];
        } else if (node.type === 'array') {
            return [
                `${name}_every: ${this._emitExpression(node.elements[0])}WhereInput`,
                `${name}_some: ${this._emitExpression(node.elements[0])}WhereInput`,
                `${name}_none: ${this._emitExpression(node.elements[0])}WhereInput`,
            ];
        } else if (node.type === 'reference') {
            if (this.enumNames.includes(expression)) {
                return [
                    `${name}: ${expression}`,
                    `${name}_not: ${expression}`,
                    `${name}_in: [${expression}!]`,
                    `${name}_not_in: [${expression}!]`,
                ];
            } else if (this.scalarNames.includes(expression)) {
                // since string has the largest set of operations, we use it
                return [
                    `${name}: ${expression}`,
                    `${name}_not: ${expression}`,
                    `${name}_in: [${expression}!]`,
                    `${name}_not_in: [${expression}!]`,
                    `${name}_lt: ${expression}`,
                    `${name}_lte: ${expression}`,
                    `${name}_gt: ${expression}`,
                    `${name}_gte: ${expression}`,
                    `${name}_contains: ${expression}`,
                    `${name}_not_contains: ${expression}`,
                    `${name}_starts_with: ${expression}`,
                    `${name}_not_starts_with: ${expression}`,
                    `${name}_ends_with: ${expression}`,
                    `${name}_not_ends_with: ${expression}`,
                ];
            }

            return [
                `${name}: ${expression}WhereInput`,
            ];
        }
        // else if (node.type === 'literal object' || node.type === 'interface') {
        //     return _(this._collectMembers(node))
        //         .map((member:Types.PropertyNode) => {
        //             return `${this._name(member.name)}: ${this._emitExpression(member.signature)}`;
        //         })
        //         .join(', ');
        // }
        else {
            return []; // throw new Error(`Can't serialize ${node.type} as an expression`);
        }
    }

    _emitInterfaceWhereUniqueInput(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const properties = [`id: ID!`];
    
        return `input ${name}WhereUniqueInput {\n${this._indent(properties.flat())}\n}`;
    }

    _emitMutationExtension(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const pascalCasedName = name.charAt(0).toUpperCase() + name.substr(1);
 
        const createMutation = `create${pascalCasedName}(data: ${name}CreateInput!): ${name}!`;
        const deleteMutation = `delete${pascalCasedName}(id: ID!): ${name}`;
        const deleteManyMutation = `deleteMany${pascalCasedName}s(where: ${name}WhereInput): ${name}BatchPayload!`;
        const updateMutation = `update${pascalCasedName}(id: ID!, data: ${name}UpdateInput!): ${name}`;
        const updateManyMutation = `updateMany${pascalCasedName}s(data: ${name}UpdateManyMutationInput!, where: ${name}WhereInput): ${name}BatchPayload!`;
        const upsertMutation = `upsert${pascalCasedName}(id: ID!, create: ${name}CreateInput!, update: ${name}UpdateInput!): ${name}!`

        const properties = [
            createMutation,
            deleteMutation,
            deleteManyMutation,
            updateMutation,
            updateManyMutation,
            upsertMutation
        ];

        return `extend type Mutation {\n${this._indent(properties)}\n}`;
    }

    _emitQueryExtension(node: Types.InterfaceNode, name: Types.SymbolName): string {
        const camelCasedName = name.charAt(0).toLowerCase() + name.substr(1);

        const singularQuery = `${camelCasedName}(id: ID!): ${name}`;
        // const singularQuery2 = `${camelCasedName}(where: ${name}WhereUniqueInput!): ${name}`;
        const queryParams = `where: ${name}WhereInput, orderBy: ${name}OrderByInput, skip: Int, after: String, before: String, first: Int, last: Int`;
        const pluralQuery = `${camelCasedName}s(${queryParams}): [${name}]!`;

        const properties = [
            singularQuery,
            pluralQuery
        ];

        return `extend type Query {\n${this._indent(properties)}\n}`;
    }

    _emitUnion(node: Types.UnionNode, name: Types.SymbolName): string {
        if (_.every(node.types, entry => entry.type === 'string literal')) {
            const nodeValues = node.types.map((type: Types.Node) => (type as Types.StringLiteralNode).value);
            return this._emitEnum({
                type: 'enum',
                values: _.uniq(nodeValues),
            }, this._name(name));
        }
    
        node.types.map(type => {
            if (type.type !== 'reference') {
                throw new Error(`GraphQL unions require that all types are references. Got a ${type.type}`);
            }
        });
    
        const firstChild = node.types[0] as ReferenceNode;
        const firstChildType = this.types[firstChild.target];
        if (firstChildType.type === 'enum') {
            const nodeTypes = node.types.map((type: Types.Node) => {
                const subNode = this.types[(type as ReferenceNode).target];
                if (subNode.type !== 'enum') {
                    throw new Error(`Expected a union of only enums since first child is an enum. Got a ${type.type}`);
                }
                return subNode.values;
            });
            return this._emitEnum({
                type: 'enum',
                values: _.uniq(_.flatten(nodeTypes)),
            }, this._name(name));
        } else if (firstChildType.type === 'interface') {
            const nodeNames = node.types.map((type: Types.Node) => {
                const subNode = this.types[(type as ReferenceNode).target];
                if (subNode.type !== 'interface') {
                    throw new Error(`Expected a union of only interfaces since first child is an interface. ` +
                        `Got a ${type.type}`);
                }
                return (type as ReferenceNode).target;
            });
            return `union ${this._name(name)} = ${nodeNames.join(' | ')}`;
        } else {
            throw new Error(`No support for unions of type: ${firstChildType.type}`);
        }
    }

    _getDocTag(node: Types.ComplexNode, prefix: string): string|null {
        if (!node.documentation) return null;
        for (const tag of node.documentation.tags) {
            if (tag.title !== 'graphql') continue;
            if (tag.description.startsWith(prefix)) return tag.description;
        }
        return null;
    }

    // Returns ALL matching tags from the given node.
    _getDocTags(node: Types.ComplexNode, prefix: string): string[] {
        const matchingTags:string[] = [];
        if (!node.documentation) return matchingTags;
        for (const tag of node.documentation.tags) {
            if (tag.title !== 'graphql') continue;
            if (tag.description.startsWith(prefix)) matchingTags.push(tag.description);
        }
        return matchingTags;
    }

    _hasDocTag(node: Types.ComplexNode, prefix: string): boolean {
        return !!this._getDocTag(node, prefix);
    }

    _indent(content: string|string[]): string {
        if (!_.isArray(content)) content = content.split('\n');
        return content.map(s => `  ${s}`).join('\n');
    }

    _isPrimitive(node: Types.Node): boolean {
        return node.type === 'string' || node.type === 'number' || node.type === 'boolean' || node.type === 'any';
    }

    _name = (name: Types.SymbolName): string => {
        name = this.renames[name] || name;
        return name.replace(/\W/g, '_');
    }

    _preprocessNode(node: Types.Node, name: Types.SymbolName):boolean {
        if (node.type === 'alias' && node.target.type === 'reference') {
            const referencedNode = this.types[node.target.target];
            if (this._isPrimitive(referencedNode) || referencedNode.type === 'enum') {
                this.renames[name] = node.target.target;
                return true;
            }
        } else if (node.type === 'alias' && this._hasDocTag(node, 'ID')) {
            this.renames[name] = 'ID';
            return true;
        }

        return false;
    }

    _transitiveInterfaces(node: Types.InterfaceNode): Types.InterfaceNode[] {
        let interfaces = [node];
        for (const name of node.inherits) {
          const inherited = <Types.InterfaceNode>this.types[name];
          interfaces = interfaces.concat(this._transitiveInterfaces(inherited));
        }
        return _.uniq(interfaces);
    }
}