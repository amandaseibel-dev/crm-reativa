# Escopos da Mensageria ULBRA: evidência medida versus anúncio público

## Anúncio público (servidor, sem consumir cota)

Lido de `https://crm.ulbra.ai/.well-known/oauth-protected-resource` em
09/11/2026. São **25 escopos anunciados** pelo recurso, incluindo
`mensagens:enviar`, `conversas:read` e `atendimentos:atender`. Isso indica o que
o servidor **suporta**, não o que cada token recebe.

## Evidência histórica (medida com token, não anunciada)

- Em 08/11/2026, o backend mostrou **18 escopos** na resposta real, conforme a
  informação recebida durante a sessão. Essa medição não foi reexecutada nesta
  rodada, porque não há token de backend disponível para consulta.
- A etapa 1 da coleta usa quatro chamadas de leitura: `listar_conversas`,
  `ler_conversa`, `listar_atendimentos` e `meu_acesso`. Isso descreve o uso do
  ReATIVA, não os escopos concedidos ao token.

## Conclusão

- `mensagens:enviar` é **anunciado**. Não há evidência, nesta data, de que o
  token central ou alguma conexão individual o recebe.
- Antes de qualquer envio, a conexão individual precisa mostrar o escopo em
  `meu_acesso`. Esse teste não envia nada.
