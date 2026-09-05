{{- define "tmjlens.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tmjlens.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "tmjlens.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tmjlens.labels" -}}
helm.sh/chart: {{ include "tmjlens.chart" . }}
{{ include "tmjlens.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "tmjlens.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tmjlens.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "tmjlens.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "tmjlens.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "tmjlens.environmentType" -}}
{{- $type := .Values.environment.type | default "" -}}
{{- if not (has $type (list "production" "staging" "development")) -}}
{{- fail (printf "environment.type must be production, staging, or development (got %q)" $type) -}}
{{- end -}}
{{- $type -}}
{{- end }}

{{- define "tmjlens.redirectUrl" -}}
{{- if .Values.azure.redirectUrl }}
{{- .Values.azure.redirectUrl }}
{{- else if and .Values.ingress.enabled .Values.ingress.host }}
{{- printf "https://%s/auth/callback" .Values.ingress.host }}
{{- else }}
{{- fail "set azure.redirectUrl, or enable ingress with a host so the OIDC callback can be derived" }}
{{- end }}
{{- end }}
