# Deploy-manager agent image: the da_boss agent runtime (node + claude) PLUS
# gcloud + kubectl, so a deploy-manager agent can drive a real deploy from its
# own pod — and stream every step to the UI like any other agent. Selected per
# agent via worker_image; runs under the Workload-Identity deploy ServiceAccount.
ARG BASE
FROM ${BASE}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl gnupg apt-transport-https ca-certificates \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" > /etc/apt/sources.list.d/google-cloud-sdk.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-cloud-cli google-cloud-cli-gke-gcloud-auth-plugin kubectl \
 && rm -rf /var/lib/apt/lists/*
ENV USE_GKE_GCLOUD_AUTH_PLUGIN=True
