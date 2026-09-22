{{- define "streamflix.fullname" -}}
{{ .Values.nameOverride | default "streamflix" }}
{{- end -}}

{{- define "streamflix.labels" -}}
app.kubernetes.io/part-of: {{ include "streamflix.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "streamflix.selectorLabels" -}}
app.kubernetes.io/name: {{ include "streamflix.fullname" . }}-{{ .component }}
{{- end -}}
