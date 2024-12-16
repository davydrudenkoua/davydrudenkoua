# Scaling AKS with Cluster Autoscaler and KEDA
### Introduction
Azure Kubernetes Service (AKS) provides a managed Kubernetes cluster with all 
the features of a self-hosted install and plays super nicely with other Azure technology.
For example, we've explored Workload Identities in [the previous post](https://davydrudenkoua.github.io/docs/aks/aks-workload-identity/) - an AKS 
capability that allows developers to use Azure's RBAC for authentication instead of connection strings and secrets.
As traffic to your application fluctuates, you might want to reduce costs during downtime and get peak performance during high load periods.
Luckily, in AKS you can enable KEDA with just one CLI switch and configure your pods scaling with just a few lines of YAML.
In this post we'll see how we can scale pods and nodes using **K**ubernetes **E**vent **D**riven **A**utoscaler and Cluster Autoscaler.
You can all source code used in this tutorial in one place in the [post's github repo](https://github.com/davydrudenkoua/k8s-keda-ca-scaling).
### KEDA
#### Basic idea
The most basic tool for scaling pods is **H**orizontal **P**od **A**utoscaler or HPA that enables 
horizontal pod scaling based on CPU or Memory utilization.
However, most modern applications have far more complex needs - for example, you might want to scale based on the amount of 
messages in Service Bus, results of a MongoDB or Prometheus query or count of blobs in Azure Blob Storage - in other words, some external event.
This is where [KEDA](https://keda.sh/) with its vast selection of [Scalers](https://keda.sh/docs/2.16/scalers/) comes in, 
and if you can't find what you are looking for there you can create your own.
Key difference between KEDA and HPA is the scaling trigger - HPA scales your pods when they are in need of more resources 
while KEDA creates new pods when some event occurs. KEDA works alongside HPA, monitoring desired event source and feeding data to HPA driving scale out/in.
More detailed overview of KEDA architecture can be found on their [documentation page](https://keda.sh/docs/2.16/concepts/).

KEDA contains two main components, which are represented as pods in `kube-system` namespace in AKS cluster.
- KEDA Metrics API Server (`keda-metrics-apiserver` pod) collects metrics from external sources that are consumed by keda-operator to drive scaling in or out.
- KEDA operator (`keda-operator` pod) acts as a scaling mastermind, ingesting metrics from `keda-metrics-apiserver` and feeding that data to `HPA` which adjusts the number of pods.
#### Configuring what and how to scale
To scale a kubernetes resource - it can even be a custom resource, although most often workloads are scaled using `Deployments` or `StatefulSets`, 
you need to define a `ScaledObject`. The `ScaledObject` custom resource is a basic piece of configuration, describing what, when and how do you want to scale.
Full `ScaledObject` CRD definition can be found on [its documentation page](https://keda.sh/docs/2.14/concepts/scaling-deployments/#scaledobject-spec).

Another key resource is `TriggerAuthentication` which describes how KEDA should authenticate against your event source. It enables you to use not only most basic authentication methods like connection string, but also more advances mechanisms like `pod/workload identity`. Its CRD definition [can be found here](https://keda.sh/docs/2.14/concepts/authentication/#re-use-credentials-and-delegate-auth-with-triggerauthentication).
### AKS Cluster Autoscaler
AKS Cluster Autoscaler is a component that monitors cluster for pending pods.  When it finds a pod that can't be created in any of the existing nodes, it creates new ones. It is worth noting that when you enable `Cluster Autoscaler`, manual scaling becomes unavailable. Because AKS operates on `VM Scale Sets`, provisioning new VMs can take some time -- around a few minutes. By default, Autoscaler expects new nodes to be provisioned in 15 minutes but you can tweak that when you enable it. You can find all available options for configuring CA on the [documentation page](https://learn.microsoft.com/en-us/azure/aks/cluster-autoscaler?tabs=azure-cli#cluster-autoscaler-profile-settings).
### Explaining the setup
In this post we will be deploying a single Docker container containing a simple Python 3.10 app.
The app connects to an Azure Service Bus Queue and echoes all received messages to the console.
To simplify config management and for security both KEDA and the python application be using Azure Workload Identity.
Python app pods will be scaled by KEDA based on the count of messages in Service Bus Queue and when there are not enough resources on existing node, new node will be created by Cluster Autoscaler.
```python
from azure.servicebus import ServiceBusClient
from azure.identity import DefaultAzureCredential
import time
import os

QUEUE_NAME = "scaling-queue"
SERVICEBUS_NAMESPACE = "k8s-scaling-demo-sb-01.servicebus.windows.net"
HOSTNAME = os.getenv("HOSTNAME") # AKS pod name

def receive_messages():
    with ServiceBusClient(SERVICEBUS_NAMESPACE, DefaultAzureCredential()) as sb_client:
        with sb_client.get_queue_receiver(QUEUE_NAME) as queue_receiver:
                print(f"Successfully connected to and listening for messages from queue {QUEUE_NAME}")
                while True:
                     for message in queue_receiver.receive_messages(max_message_count=5, max_wait_time=5):
                          print(f"Pod {HOSTNAME} received new message #{message.sequence_number}: {str(message)}, beginning processing")
                          time.sleep(5)
                          print(f"Pod {HOSTNAME} processed message #{message.sequence_number}")
                          queue_receiver.complete_message(message)

if __name__ == "__main__":
    try:
          receive_messages()
    except Exception as exception:
        print(f"Exception raised while listening to messages: {repr(exception)}")
```
### Setting up AKS
#### Prerequisites
-  Azure Subscription
-  Service Account with a single Queue
-  Azure CLI >= 2.47.0
-  aks-preview Azure CLI extension >= 9.0.0b7
#### Function to create User-Assigned Managed Identity
Because we will need two managed identities for KEDA and the app itself, common part can be extracted to reusable function.
```powershell
function Add-UserIdentity {
    param (
        [Parameter(Mandatory)][string] $Subscription,
        [Parameter(Mandatory)][string] $ResourceGroupName,
        [Parameter(Mandatory)][string] $Location,
        [Parameter(Mandatory)][string] $UserAssignedIdentityName,
        [Parameter(Mandatory)][string] $ServiceBusNamespace,
        [Parameter(Mandatory)][string] $ServiceBusRole
    )
    az identity create `
        --name $UserAssignedIdentityName `
        --resource-group $ResourceGroupName `
        --location $Location

    $UserAssignedIdentityClientId = $(az identity show --resource-group $ResourceGroupName --name $UserAssignedIdentityName --query 'clientId' -o tsv)

    $ServiceBusId = $(az servicebus namespace show --name $ServiceBusNamespace --resource-group $ResourceGroupName --query "id" -o tsv)
    az role assignment create `
        --assignee $UserAssignedIdentityClientId `
        --role $ServiceBusRole `
        --scope $ServiceBusId

    return  @{
        ClientId = $UserAssignedIdentityClientId
        TenantId = $(az identity show --resource-group $ResourceGroupName --name $UserAssignedIdentityName --query 'tenantId' -otsv)
    }
}
```
#### Creating necessary variables
```powershell
$ResourceGroupName = "k8s-scaling-demo"
$ClusterName = "aks-scaling-demo"

$KedaFederatedIdentityName = "keda-federated-identity"
$QueueListenerFederatedIdentityName = "queue-listener-federated-identity"
$KedaUserAssignedIdentityName = "keda-user-assigned-identity"
$QueueListenerUserAssignedIdentityName="queue-listener-user-assigned-identity"
$QueueListenerServiceAccountName = "queue-listener"
$Location = $(az group show --name $ResourceGroupName --query "location" -o tsv)
$SubscriptionId = $(az account show --query "id" --output tsv)
$ScalingQueueName ="scaling-queue"
$ScalingQueueNamespace = "k8s-scaling-demo-sb-01"

$DockerUsername = $Env:DOCKER_USERNAME
$DockerPassword = $Env:DOCKER_PASSWORD
$DockerServer = "https://index.docker.io/v1/"
```
#### AKS Creation and Setup
```powershell
Write-Host "Creating AKS"
az aks create `
        --resource-group $ResourceGroupName `
        --name $ClusterName `
        --enable-oidc-issuer `
        --enable-workload-identity `
        --enable-keda `
        --generate-ssh-keys `
        --location $Location `
        --node-vm-size "Standard_B2s" `
        --tier "free" `
        --node-count 1 `
        --enable-cluster-autoscaler ` # CA parameters start here
        --min-count 1 `               # Lowest possible node count
        --max-count 2 `               # Highest possible node count
        --cluster-autoscaler-profile scan-interval=30s, ` # Check for underutilized nodes/scheduled pods every 30s
            max-graceful-termination-sec=30, `
            max-node-provision-time=15m, `
            new-pod-scale-up-delay=10s, `                 # Ignore unscheduled pods before they are 10s old
            scale-down-utilization-threshold=0.7, `       # Sum of requested resources divided by capacity below which node can be removed
            scale-down-unneeded-time=1m                   # How long a node should be unneeded before it's eligible for scale down

az aks get-credentials --name $ClusterName --resource-group $ResourceGroupName

$AksOidcIssuer = $(
    az aks show `
        --name $ClusterName `
        --resource-group $ResourceGroupName `
        --query "oidcIssuerProfile.issuerUrl" `
        -o tsv
    )
Write-Host "AKS $ClusterName created and connected to kubectl"

#Creating secret to pull Docker image from private registry
kubectl create secret docker-registry queue-listener-registry-secret `
    --docker-server $DockerServer `
    --docker-username $DockerUsername `
    --docker-password $DockerPassword
```
#### Creating KEDA and application identity
Both `KEDA` and `queue-listener` are using `AKS Workload Identity` to authenticate against Service Bus Queue, so we are assigning RBAC roles accordingly.
```powershell
Write-Host "Creating user-assigned keda identity"
$KedaIdentityParams = @{
    Subscription = $SubscriptionId
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    UserAssignedIdentityName = $KedaUserAssignedIdentityName
    ServiceBusNamespace = $ScalingQueueNamespace
    ServiceBusRole = "Azure Service Bus Data Owner"
}
$KedaUserAssignedIdentityValues = Add-UserIdentity @KedaIdentityParams

az identity federated-credential create `
--name $KedaFederatedIdentityName `
--identity-name $KedaUserAssignedIdentityName `
--resource-group $ResourceGroupName `
--issuer $AksOidcIssuer `
--subject system:serviceaccount:kube-system:keda-operator `
--audience api://AzureADTokenExchange
Write-Host "User-assigned keda identity created"

Write-Host "Creating user-assigned queue-listener identity"
$QueueListenerIdentityParams = @{
    Subscription = $SubscriptionId
    ResourceGroupName = $ResourceGroupName
    Location = $Location
    UserAssignedIdentityName = $QueueListenerUserAssignedIdentityName
    ServiceBusNamespace = $ScalingQueueNamespace
    ServiceBusRole = "Azure Service Bus Data Receiver"
}
$QueueListenerUserAssignedIdentityValues = Add-UserIdentity @QueueListenerIdentityParams

az identity federated-credential create `
    --name $QueueListenerFederatedIdentityName `
    --identity-name $QueueListenerUserAssignedIdentityName `
    --resource-group $ResourceGroupName `
    --issuer $AksOidcIssuer `
    --subject system:serviceaccount:default:$QueueListenerServiceAccountName `
    --audience api://AzureADTokenExchange
Write-Host "User-assigned queue-listener identity created"
```
#### Applying Service Account template for the app
Application's Service Account is really simple and is needed to bind pod to existing User-Assigned Managed Identity.
`{{QUEUE_LISTENER_USER_ASSIGNED_CLIENT_ID}}` will be replaced by an actual value later in the script when the template is actually applied.
```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  annotations:
    azure.workload.identity/client-id: {{QUEUE_LISTENER_USER_ASSIGNED_CLIENT_ID}}
  name: queue-listener
```
Configuring and applying the template:
```powershell
Write-Host "Creating queue-listener service account"
$QueueListenerServiceAccountTemplate = Get-Content -Path "k8s/service-accounts/queue-listener.service-account.yaml" -Raw
$QueueListenerServiceAccountTemplate = $QueueListenerServiceAccountTemplate -replace `
    "{{QUEUE_LISTENER_USER_ASSIGNED_CLIENT_ID}}", $QueueListenerUserAssignedIdentityValues.ClientId

$QueueListenerServiceAccountTemplate | kubectl apply -f -
Write-Host "Queue-listener service account created"
```
#### Restarting keda to enable Workload Identity
This needs to be done because even though AKS was created with Workload Identity enabled, KEDA didn't start using it and needs to be restarted.
```powershell
kubectl rollout restart deploy keda-operator -n kube-system
```
#### Applying Application deployment template
The actual deployment has only one pod running a Docker image from private registry and it will be automatically scaled by KEDA.
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name:  queue-listener
  labels:
    app:  queue-listener
spec:
  selector:
    matchLabels:
      app: queue-listener
  template:
    metadata:
      labels:
        app:  queue-listener
        azure.workload.identity/use: "true"
    spec:
      serviceAccountName: queue-listener
      containers:
      - name:  queue-listener
        image:  davydrudenkoua/queue-listener:latest
        resources:
          requests:
            cpu: 300m
            memory: 300Mi
          limits:
            cpu: 300m
            memory: 300Mi
      imagePullSecrets:
        - name: queue-listener-registry-secret
```
```powershell
Write-Host "Creating queue-listener deployment"
kubectl apply -f "k8s/deployments/queue-listener.deployment.yaml"
Write-Host "Queue-listener deployment created"
```
#### Deploying KEDA scaled object
```yaml
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication # CRD that defines Workload Identity authentication to be used for scaling
metadata:
  name: queue-listener-sb-auth
spec:
  podIdentity:
    provider: azure-workload
    identityId: {{KEDA_USER_ASSIGNED_IDENTITY_CLIENT_ID}}
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: queue-listener-sb-scaledobject
spec:
  scaleTargetRef:
    kind: Deployment                # Optional
    name: queue-listener            # Must be in the same namespace as the ScaledObject
  minReplicaCount: 0
  maxReplicaCount: 5
  cooldownPeriod: 15                # The time in seconds to wait after the last
                                    # trigger invocation before scaling in
  triggers:
  - type: azure-servicebus
    metadata:
      queueName: {{SCALING_QUEUE_NAME}}
      namespace: {{SCALING_QUEUE_NAMESPACE}}
      messageCount: "10"            # Basically a number of messages one pod can reliably handle
      activationMessageCount: "0"   # Optional. The number of messages until KEDA activates the scaler.
                                    # For example, # if you have activationMessageCount: "5"
                                    # and minReplicaCount: 0, KEDA won't  create any pods if
                                    # there are less than 5 active messages
    authenticationRef:
      name: queue-listener-sb-auth
```
```powershell
Write-Host "Deploying queue-listener scaled object"
$ScaledObjectAccountTemplate = Get-Content -Path "k8s/keda/queue-listener.scaled-object.yaml" -Raw
$ScaledObjectAccountTemplate = $ScaledObjectAccountTemplate -replace "{{KEDA_USER_ASSIGNED_IDENTITY_CLIENT_ID}}", $KedaUserAssignedIdentityValues.ClientId
$ScaledObjectAccountTemplate = $ScaledObjectAccountTemplate -replace "{{SCALING_QUEUE_NAME}}", $ScalingQueueName
$ScaledObjectAccountTemplate = $ScaledObjectAccountTemplate -replace "{{SCALING_QUEUE_NAMESPACE}}", $ScalingQueueNamespace
$ScaledObjectAccountTemplate | kubectl apply -f -
Write-Host "Queue-listener scaled object created"
```
### Useful commands
Get AKS CA logs
```powershell
kubectl get events --field-selector source=cluster-autoscaler
```
Watching pod logs in real-time
```powershell
kubectl logs <pod-name> --follow
```
Getting KEDA logs
```powershell
kubectl get pod -n kube-system # locate keda-operator pod
kubectl logs <keda-operator-pod-name>
```
Checking if workload identity is enabled for KEDA
```powershell
kubectl get pod -n kube-system # locate keda-operator pod
kubectl describe pod <keda-operator-pod-name> -n kube-system # Look for AZURE_TENANT_ID,
                                                             # AZURE_FEDERATED_IDENTITY_FILE
                                                             # and AZURE_AUTHORITY_HOST variables
```





