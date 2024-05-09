"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const body_parser_1 = __importDefault(require("body-parser"));
const k8s = __importStar(require("@kubernetes/client-node"));
const client_node_1 = require("@kubernetes/client-node");
const version_1 = require("./version");
// Configures connection to the Kubernetes cluster
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
var logLevel = 0;
var enableConsole = false;
// Create the kubernetes clients
const coreApi = kc.makeApiClient(client_node_1.CoreV1Api);
const networkingApi = kc.makeApiClient(client_node_1.NetworkingV1Api);
const appsApi = kc.makeApiClient(client_node_1.AppsV1Api);
const crdApi = kc.makeApiClient(client_node_1.CustomObjectsApi);
const rbacApi = kc.makeApiClient(client_node_1.RbacAuthorizationV1Api);
async function createRole(authorizatorName, namespace) {
    var role = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'Role',
        metadata: {
            name: `obk-authorizator-${authorizatorName}-role`
        },
        rules: [
            { apiGroups: [''], resources: ['secrets'], verbs: ['get', 'add', 'update'] }
        ]
    };
    await rbacApi.createNamespacedRole(namespace, role);
}
async function createRoleBinding(authorizatorName, namespace) {
    var roleBinding = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: {
            name: `obk-authorizator-${authorizatorName}-rolebinding`
        },
        subjects: [
            { kind: 'ServiceAccount', name: `obk-authorizator-${authorizatorName}-sa`, namespace: namespace }
        ],
        roleRef: {
            kind: 'Role',
            name: `obk-authorizator-${authorizatorName}-role`
        }
    };
    await rbacApi.createNamespacedRoleBinding(namespace, roleBinding);
}
async function createServiceAccount(authorizatorName, namespace) {
    const serviceAccount = {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: {
            name: `obk-authorizator-${authorizatorName}-sa`
        }
    };
    await coreApi.createNamespacedServiceAccount(namespace, serviceAccount);
}
async function checkIngress(name, namespace, ingressClassName) {
    //+++ Check that ingress do exist with specified CLASS NAME
    try {
        var ing = await networkingApi.readNamespacedIngress(name, namespace);
        log(1, ing);
    }
    catch (err) {
        if (err.statusCode === 404)
            log(0, "Error, inexistent ingress: " + name);
        else {
            log(0, "Error checking ingress");
            log(0, err);
        }
        return false;
    }
    return true;
}
//+++ Traefik middleware is under development
async function createTraefikMiddleware(authorizatorName, authorizatorNamespace, clusterName, spec) {
    // +++ create a CRD resource
    /*
    apiVersion: traefik.io/v1alpha1
    kind: Middleware
    metadata:
      name: testauth
      namespace: dev
    spec:
      forwardAuth:
        address: http://.....
    */
    var address = `http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3882/validate/${authorizatorName}`;
    var resource = {
        apiVersion: 'traefik.io/v1alpha1',
        kind: 'Middleware',
        metadata: {
            name: `obk-traefik-middleware-${authorizatorName}`,
            namespace: authorizatorNamespace
        },
        spec: {
            forwardAuth: {
                address: address
            }
        }
    };
    log(2, 'Creating traefik middleware: ');
    log(2, resource);
    await crdApi.createNamespacedCustomObject('traefik.io', 'v1alpha1', authorizatorNamespace, 'middlewares', resource);
}
async function annotateIngress(authorizatorName, authorizatorNamespace, clusterName, spec) {
    /* NGINX Ingress
    nginx.org/location-snippets: |
      auth_request /auth;
    nginx.org/server-snippets: |
      location = /auth {
        proxy_pass http://clusterdns:port/validate/ingressname;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-URI $request_uri;
      }
    */
    log(1, 'Annotating ingress ' + spec.ingress.name + ' of provider ' + spec.ingress.provider);
    const response2 = await networkingApi.readNamespacedIngress(spec.ingress.name, authorizatorNamespace);
    var ingressObject = response2.body;
    switch (spec.ingress.provider) {
        case 'ingress-nginx':
            ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'] = `http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3882/validate/${authorizatorName}`;
            ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'] = 'GET';
            ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-response-headers'] = 'WWW-Authenticate';
            break;
        case 'nginx-ingress':
            //var headersSnippet = 'sssss';
            var locationSnippet = 'auth_request /obk-auth;';
            var serverSnippet = `location = /obk-auth { proxy_pass http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3882/validate/${authorizatorName}; proxy_pass_request_body off; proxy_set_header Content-Length ""; proxy_set_header X-Original-URI $request_uri; }`;
            ingressObject.metadata.annotations['nginx.org/location-snippets'] = locationSnippet;
            ingressObject.metadata.annotations['nginx.org/server-snippets'] = serverSnippet;
            break;
        case 'haproxy':
            log(0, 'HAProxy ingress still not supported... we are working hard!');
            break;
        case 'traefik':
            await createTraefikMiddleware(authorizatorName, authorizatorNamespace, clusterName, spec);
            ingressObject.metadata.annotations['traefik.ingress.kubernetes.io/router.middlewares'] = `${authorizatorNamespace}-obk-traefik-middleware-${authorizatorName}@kubernetescrd`;
            break;
        default:
            log(0, 'Invalid ingress provider to annotate');
            break;
    }
    await networkingApi.replaceNamespacedIngress(spec.ingress.name, authorizatorNamespace, ingressObject);
    log(1, 'Ingress annotated');
}
async function createObkAuthorizator(authorizatorName, authorizatorNamespace, clusterName, spec) {
    //create deployment
    log(1, 'Creating Deployment');
    var deploymentName = 'obk-authorizator-' + authorizatorName + '-deply';
    try {
        var appName = 'obk-authorizator-' + authorizatorName + '-listener';
        // Create the spec fo the deployment
        const deploymentSpec = {
            replicas: spec.config.replicas,
            selector: { matchLabels: { app: appName } },
            template: {
                metadata: {
                    labels: { app: appName },
                    annotations: {
                        'oberkorn.jfvilas.at.outlook.com/ingress': spec.ingress.name,
                        'oberkorn.jfvilas.at.outlook.com/authorizator': authorizatorName,
                        'oberkorn.jfvilas.at.outlook.com/namespace': authorizatorNamespace
                    }
                },
                spec: {
                    serviceAccountName: `obk-authorizator-${authorizatorName}-sa`,
                    containers: [
                        {
                            name: 'obk-authorizator-' + authorizatorName + '-cont',
                            image: 'obk-authorizator',
                            ports: [{ containerPort: 3882, protocol: 'TCP' }],
                            env: [
                                { name: 'OBKA_NAME', value: authorizatorName },
                                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace },
                                { name: 'OBKA_RULESETS', value: JSON.stringify(spec.rulesets) },
                                { name: 'OBKA_VALIDATORS', value: JSON.stringify(spec.validators) },
                                { name: 'OBKA_API', value: JSON.stringify(spec.config.api) },
                                { name: 'OBKA_PROMETHEUS', value: JSON.stringify(spec.config.prometheus) },
                                { name: 'OBKA_LOG_LEVEL', value: JSON.stringify(spec.config.logLevel) }
                            ],
                            imagePullPolicy: 'Never' //+++ this is a specific requirement of K3D
                        },
                    ]
                },
            },
            strategy: {
                type: 'RollingUpdate',
                rollingUpdate: {
                    maxSurge: 1,
                    maxUnavailable: 0
                }
            }
        };
        // create a Deployment object
        const deployment = {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
                name: deploymentName,
                namespace: authorizatorNamespace
            },
            spec: deploymentSpec,
        };
        // Create the Deployment in the cluster
        await appsApi.createNamespacedDeployment(authorizatorNamespace, deployment);
        log(1, 'Deployment successfully created');
        // Create a Service
        log(1, 'Creting service service');
        var serviceName = 'obk-authorizator-' + authorizatorName + '-svc';
        var serviceBody = new k8s.V1Service();
        serviceBody = {
            apiVersion: "v1",
            metadata: {
                name: serviceName,
                namespace: authorizatorNamespace
            },
            spec: {
                ports: [{ protocol: 'TCP', port: 3882, targetPort: 3882 }],
                selector: { app: appName },
                type: 'ClusterIP'
            }
        };
        await coreApi.createNamespacedService(authorizatorNamespace, serviceBody);
        log(1, 'Service created succesfully');
        await annotateIngress(authorizatorName, authorizatorNamespace, clusterName, spec);
        // create service account
        log(1, 'Creating SA');
        await createServiceAccount(authorizatorName, authorizatorNamespace);
        log(1, 'SA created succesfully');
        // create role
        log(1, 'Creating Role');
        await createRole(authorizatorName, authorizatorNamespace);
        log(1, 'Role created succesfully');
        // create role binding
        log(1, 'Creating RoleBinding');
        await createRoleBinding(authorizatorName, authorizatorNamespace);
        log(1, 'RoleBinding created succesfully');
    }
    catch (err) {
        log(0, 'Error  creating the ObkAuthorizator');
        log(0, err);
    }
}
async function processAdd(authorizatorObject, clusterName) {
    var namespace = authorizatorObject.metadata.namespace;
    if (namespace === undefined)
        namespace = 'default';
    var ingress = authorizatorObject.spec.ingress;
    if (!(await checkIngress(ingress.name, namespace, ingress.class))) {
        log(0, "Ingress validation failed");
        return false;
    }
    createObkAuthorizator(authorizatorObject.metadata.name, namespace, clusterName, authorizatorObject.spec);
    return true;
}
async function deleteObkAuthorizator(authorizatorName, authorizatorNamespace, spec) {
    var _a, _b, _c;
    try {
        var deploymentName = 'obk-authorizator-' + authorizatorName + '-deply';
        var depResp = await appsApi.readNamespacedDeployment(deploymentName, authorizatorNamespace);
        var deployment = depResp.body;
        var ingressName = ((_c = (_b = (_a = deployment.spec) === null || _a === void 0 ? void 0 : _a.template) === null || _b === void 0 ? void 0 : _b.metadata) === null || _c === void 0 ? void 0 : _c.annotations)['oberkorn.jfvilas.at.outlook.com/ingress'];
        //delete deployment
        var response = await appsApi.deleteNamespacedDeployment(deploymentName, authorizatorNamespace);
        log(1, `Deployment ${deploymentName} successfully removed`);
        //delete service
        var servName = 'obk-authorizator-' + authorizatorName + '-svc';
        const respServ = await coreApi.deleteNamespacedService(servName, authorizatorNamespace);
        log(1, `Service ${servName} successfully removed`);
        // de-annotate ingress
        log(1, 'De-annotating ingress ' + ingressName);
        const ingressResponse = await networkingApi.readNamespacedIngress(ingressName, authorizatorNamespace);
        var ingressObject = ingressResponse.body;
        switch (spec.ingress.provider) {
            case 'ingress-nginx':
                if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'])
                    delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-url'];
                if (ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'])
                    delete ingressObject.metadata.annotations['nginx.ingress.kubernetes.io/auth-method'];
                break;
            case 'nginx-ingress':
                if (ingressObject.metadata.annotations['nginx.org/location-snippets'])
                    delete ingressObject.metadata.annotations['nginx.org/location-snippets'];
                if (ingressObject.metadata.annotations['nginx.org/server-snippets'])
                    delete ingressObject.metadata.annotations['nginx.org/server-snippets'];
                break;
            case 'traefik':
                var name = `obk-traefik-middleware-${authorizatorName}`;
                await crdApi.deleteNamespacedCustomObject('traefik.io', 'v1alpha1', authorizatorNamespace, 'middlewares', name);
                break;
        }
        await networkingApi.replaceNamespacedIngress(ingressName, authorizatorNamespace, ingressObject);
        log(1, 'Ingress updated');
        //delete service account
        log(1, `Removing SA`);
        const respSA = await coreApi.deleteNamespacedServiceAccount(`obk-authorizator-${authorizatorName}-sa`, authorizatorNamespace);
        log(1, `SA successfully removed`);
        //delete role
        log(1, `Removing Role`);
        const respRole = await rbacApi.deleteNamespacedRole(`obk-authorizator-${authorizatorName}-role`, authorizatorNamespace);
        log(1, `Role successfully removed`);
        //delete rolebinsing
        log(1, `Removing RoleBinding`);
        const respRoleBinding = await rbacApi.deleteNamespacedRoleBinding(`obk-authorizator-${authorizatorName}-rolebinding`, authorizatorNamespace);
        log(1, `RoleBinding successfully removed`);
    }
    catch (err) {
        if (err.statusCode === 404) {
            log(0, `WARNING, ObkAuthorizator ${authorizatorName} doesn't exist.`);
        }
        else {
            log(0, 'Error removing ObkAuthorizator');
            log(0, err);
        }
    }
}
async function processDelete(authorizatorObject) {
    var ns = authorizatorObject.metadata.namespace;
    if (ns === undefined)
        ns = 'default';
    await deleteObkAuthorizator(authorizatorObject.metadata.name, ns, authorizatorObject.spec);
}
async function modifyObkAuthorizator(authorizatorName, authorizatorNamespace, spec) {
    // modify the Deployment
    log(1, 'Modifying Deployment');
    var deploymentName = 'obk-authorizator-' + authorizatorName + '-deply';
    try {
        var appName = 'obk-authorizator-' + authorizatorName + '-listener';
        // Create the spec
        const deploymentSpec = {
            replicas: spec.config.replicas,
            selector: { matchLabels: { app: appName } },
            template: {
                metadata: {
                    labels: { app: appName },
                    annotations: {
                        'oberkorn.jfvilas.at.outlook.com/ingress': spec.ingress.name,
                        'oberkorn.jfvilas.at.outlook.com/authorizator': authorizatorName,
                        'oberkorn.jfvilas.at.outlook.com/namespace': authorizatorNamespace
                    }
                },
                spec: {
                    containers: [
                        {
                            name: appName,
                            image: 'obk-authorizator',
                            ports: [{ containerPort: 3882, protocol: 'TCP' }],
                            env: [
                                { name: 'OBKA_NAME', value: authorizatorName },
                                { name: 'OBKA_NAMESPACE', value: authorizatorNamespace },
                                { name: 'OBKA_RULESETS', value: JSON.stringify(spec.rulesets) },
                                { name: 'OBKA_VALIDATORS', value: JSON.stringify(spec.validators) },
                                { name: 'OBKA_API', value: JSON.stringify(spec.config.api) },
                                { name: 'OBKA_PROMETHEUS', value: JSON.stringify(spec.config.prometheus) },
                                { name: 'OBKA_LOG_LEVEL', value: JSON.stringify(spec.config.logLevel) }
                            ],
                            imagePullPolicy: 'Never' //+++ this is a specific requirementof K3D
                        },
                    ],
                },
            },
            strategy: {
                type: 'RollingUpdate',
                rollingUpdate: {
                    maxSurge: 1,
                    maxUnavailable: 0
                }
            }
        };
        // Crete the Deploymnet object
        const deployment = {
            apiVersion: 'apps/v1',
            kind: 'Deployment',
            metadata: {
                name: deploymentName,
                namespace: authorizatorNamespace
            },
            spec: deploymentSpec,
        };
        await appsApi.replaceNamespacedDeployment(deploymentName, authorizatorNamespace, deployment);
        log(1, 'Deployment successfully modified');
    }
    catch (err) {
        log(0, 'Error modifying ObkAuthorizator');
        log(0, err);
    }
}
async function processModify(authorizatorObject) {
    var namespace = authorizatorObject.metadata.namespace;
    if (namespace === undefined)
        namespace = 'default';
    var ingress = authorizatorObject.spec.ingress;
    if (!(await checkIngress(ingress.name, namespace, ingress.class))) {
        log(0, "Ingress validation failed: " + ingress.name);
        return false;
    }
    await modifyObkAuthorizator(authorizatorObject.metadata.name, namespace, authorizatorObject.spec);
    return true;
}
async function testAccess() {
    try {
        log(0, "Testing cluster access");
        const nss = await coreApi.listNamespace();
    }
    catch (err) {
        log(0, "Error accessing cluster on Controller start:");
        log(0, err);
    }
}
async function postData(url = "", data = {}) {
    // Default options are marked with *
    console.log('tosend:' + JSON.stringify(data));
    const response = await fetch(url, {
        method: "POST", // *GET, POST, PUT, DELETE, etc.
        mode: "cors", // no-cors, *cors, same-origin
        cache: "no-cache", // *default, no-cache, reload, force-cache, only-if-cached
        credentials: "same-origin", // include, *same-origin, omit
        headers: {
            "Content-Type": "application/json",
            // 'Content-Type': 'application/x-www-form-urlencoded',
        },
        redirect: "follow", // manual, *follow, error
        referrerPolicy: "no-referrer", // no-referrer, *no-referrer-when-downgrade, origin, origin-when-cross-origin, same-origin, strict-origin, strict-origin-when-cross-origin, unsafe-url
        body: JSON.stringify(data), // body data type must match "Content-Type" header
    });
    return response.json(); // parses JSON response into native JavaScript objects
}
async function listen(clusterName) {
    if (enableConsole) {
        log(0, 'Configuring Web Console endpoint');
        const app = (0, express_1.default)();
        const port = 3882;
        app.listen(port, () => {
            log(0, `Oberkorn Controller Web Console listening at port ${port}`);
        });
        app.use(body_parser_1.default.json());
        // serve SPA as a static endpoint
        app.use('/obk-console', express_1.default.static('./dist/console'));
        // serve cluster authorizators list
        app.use('/obk-console/authorizators', async (req, res) => {
            var auth = await crdApi.listClusterCustomObject('jfvilas.at.outlook.com', 'v1', 'obkauthorizators');
            var auths = [];
            for (auth of auth.body.items) {
                var authorizator = auth;
                console.log(authorizator);
                if (authorizator.spec.config.api) {
                    auths.push({ name: authorizator.metadata.name, namespace: authorizator.metadata.namespace });
                }
            }
            res.status(200).json(auths);
        });
        // serve authorizatros proxy
        app.use('/obk-console/proxy', async (req, res) => {
            // reroute the request to the authorizator
            // received
            // http://localhost/obk-console/proxy/dev/obk-authorizator/obk-console-authorizator/api/config
            // reroute
            // http://localhost/obk-authorizator/dev/obk-console-authorizator/api/config
            var path = req.originalUrl;
            console.log('url:' + path);
            var i = path.indexOf('/proxy/');
            var path = path.substring(i + 7);
            console.log('local:' + path);
            i = path.indexOf('/');
            var authorizatorNamespace = path.substring(0, i);
            path = path.substring(i + 1);
            i = path.indexOf('/');
            var authorizatorName = path.substring(0, i);
            path = path.substring(i);
            var pathPrefix = `/obk-authorizator/${authorizatorNamespace}/${authorizatorName}`;
            var address = `http://obk-authorizator-${authorizatorName}-svc.${authorizatorNamespace}.svc.${clusterName}:3882` + pathPrefix + path;
            console.log('authns:' + authorizatorNamespace);
            console.log('authnm:' + authorizatorName);
            console.log('path:' + path);
            console.log('address:' + address);
            switch (req.method) {
                case 'GET':
                    fetch(address).then(async (response) => {
                        console.log('response');
                        //console.log(await response.text());
                        var json = await response.json();
                        console.log(json);
                        res.status(200).json(json);
                    })
                        .catch(err => {
                        console.log(err);
                        res.status(500).json(err);
                    });
                    break;
                case 'POST':
                    try {
                        postData(address, req.body).then((data) => {
                            console.log('received:' + data);
                            res.status(200).json(data);
                        })
                            .catch((err) => {
                            console.log(err);
                            console.log('catchpost');
                            res.status(500).json({ ok: false, err: err });
                        });
                    }
                    catch (err) {
                        console.log(err);
                        console.log('catch');
                        res.status(500).json({ ok: false, err: err });
                    }
                    break;
            }
        });
    }
}
async function main(clusterName) {
    try {
        // launch express to serve web console
        listen(clusterName);
        log(0, "Oberkorn Controller is watching events...");
        const watch = new k8s.Watch(kc);
        watch.watch('/apis/jfvilas.at.outlook.com/v1/obkauthorizators', {}, async (type, obj) => {
            log(0, "Received event: " + type);
            log(0, `${obj.metadata.namespace}/${obj.metadata.name} (class: ${obj.spec.ingress.class})`);
            log(1, obj);
            switch (type) {
                case "ADDED":
                    await processAdd(obj, clusterName);
                    break;
                case "DELETED":
                    await processDelete(obj);
                    break;
                case "MODIFIED":
                    await processModify(obj);
                    break;
                default:
                    log(0, "****** UNKNOWN EVENT ******: " + type);
                    log(0, type);
                    log(0, obj);
                    break;
            }
        }, (err) => {
            log(0, err);
        });
    }
    catch (err) {
        log(0, "MAINERR");
        log(0, err);
    }
}
;
function log(level, obj) {
    if (logLevel >= level)
        console.log(obj);
}
function redirLog() {
    console.log("Redirecting log");
    const origLog = console.log;
    console.log = (a) => {
        if (a && a.response !== undefined) {
            //console.log(typeof(a));
            a = {
                statusCode: a.response.statusCode,
                statuesMessage: a.response.statusMessage,
                method: a.response.request.method,
                path: a.response.request.path,
                body: a.response.body
            };
        }
        origLog(a);
    };
    console.error = (a) => {
        origLog("*********ERR*********");
        origLog(a);
    };
    console.debug = (a) => {
        origLog("*********DEB*********");
        origLog(a);
    };
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
console.log('Oberkorn Controller is starting...');
console.log(`Oberkorn Controller version is ${version_1.VERSION}`);
if (process.env.OBKC_LOG_LEVEL !== undefined)
    logLevel = +process.env.OBKC_LOG_LEVEL;
if (process.env.OBKC_CONSOLE === 'true')
    enableConsole = true;
console.log('Log level: ' + logLevel);
// filter log messages
redirLog();
if (!testAccess()) {
    console.log("Oberkorn controller cannot access cluster");
}
else {
    // launch controller
    main('cluster.local');
}
