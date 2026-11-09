# Escopos da Mensageria ULBRA: evidência histórica e anúncio público

## Evidência histórica (diagnóstico do backend, 08/11/2026)

O diagnóstico do backend mostrou **18 escopos**, entre eles `mensagens:enviar`.
Isso é evidência histórica de que o backend declarou esse escopo para o token
medido naquela data. **Não prova envio.** Também **não prova autoria individual**:
o escopo indica permissão, não quem aparece como autor de uma mensagem.

Esta rodada não reexecutou essa medição, porque não há token de backend
disponível nesta sessão.

## Anúncio público (servidor, sem consumir cota, 09/11/2026)

O recurso protegido anuncia **25 escopos**, incluindo `mensagens:enviar`,
`conversas:read` e `atendimentos:atender`. Isso mostra o que o servidor
**suporta**, não o que cada token recebe. Os 25 e os 18 não são comparáveis
sem a lista de escopos do token na mesma data.

## Uso da coleta

A coleta atual usa quatro leituras: `listar_conversas`, `ler_conversa`,
`listar_atendimentos` e `meu_acesso`. Isso descreve o que o ReATIVA chama, não
o que o token recebe.

## Conclusão

- `mensagens:enviar` consta na evidência histórica e no anúncio atual.
- Antes de qualquer envio, a conexão individual precisa mostrar o escopo em
  `meu_acesso`, por leitura. Esse passo não envia nada.
- Autoria individual só é comprovada com um envio real autorizado, conferido
  pela própria conta remetente.
