# Decisões da integração ULBRA / Mensageria (registro versionado)

Registro das decisões tomadas pela gestão, com a data e o escopo do que foi decidido. Não é ata nem
aprovação de implantação. Aprovações de implantação ficam no pacote e na mensagem de implantação, com
a aprovação específica de cada etapa. Este registro é referenciado pela PR #913.

## Decisões registradas

| Data | Decisão | Escopo | Fonte |
|---|---|---|---|
| 2026-11-17 | Alcance da regra dos cinco: vale para descobertas e alterações relevantes da integração Prime. Documentação exclusiva da Mensageria não exige atualização dos cinco. | README (`docs/integracoes/README.md`) e seletor (`plugins/reativa-one/scripts/integracoes-cinco.sh`) | mensagem da gestão nesta sessão |
| 2026-11-17 | Seletor com resultados distintos: NAO_APLICA (0), PRESENCA_VERIFICADA (0), REVISAO_HUMANA (3), FALTAM (2). PRESENCA_VERIFICADA não significa conteúdo correto. | seletor | mensagem da gestão nesta sessão |
| 2026-11-17 | Leitura do histórico primeiro, envio desligado durante a validação de leitura. | piloto | mensagem da gestão nesta sessão |
| 2026-11-17 | Leitura limitada às identidades listadas em `ULBRA_HISTORICO_PILOTO_EMAILS` (fail-closed), sem alterar as regras permanentes de carteira e responsabilidade. | piloto | mensagem da gestão nesta sessão |
| 2026-11-17 | Contenção da função antiga `ulbra-historico` concluída: função excluída pelo painel, ausente da listagem, endpoint HTTP 404. Não restaurar. | produção | informado pela gestão; verificado por leitura |
| 2026-11-17 | Aluno de teste entra na fila do operador João como CONTATAR. CPF obrigatório preenchido pela gestão, no cadastro. | piloto | mensagem da gestão nesta sessão |

## Dependência de envio real: bloqueio jurídico (registrada; envio real NÃO habilitado)

- Antes de habilitar `ULBRA_ENVIO_REAL`, a `ulbra-conversa` deve respeitar o **bloqueio jurídico efetivo** do aluno na prévia e na confirmação.
- Não é proibição definitiva: fica prevista uma **exceção específica, auditada e autorizada pela gestão**, para atendimento não relacionado à cobrança.
- Contrato da verificação a coordenar com a sessão do Jurídico (sem edição paralela dos mesmos arquivos). Proposta: função de decisão pura `decidirBloqueioJuridico(aluno, tipoAtendimento, excecao)` na ulbra-conversa, chamada antes de `envio_previa` e `envio_confirmar`; retorno `BLOQUEADO_JURIDICO` (403) sem efeito; exceção só com registro de autorização e auditoria.
- Esta dependência **não** impede o piloto de leitura com envio desligado.

## Pendente de decisão (não decidido, não aceito)

- **Grant OAuth sem cópia quando a revogação falha** (ramos de divergência, erro de banco e renovação
  recusada): o risco não foi aceito. Pelo piloto, o caminho fica indisponível (ver piloto-token-pessoal-2026-11-17.md).
  Antes de habilitar o OAuth, a gestão precisa decidir: aceitar o risco com registro, ou corrigir.
- Migrations `20261111140000` e `20261117120000`: aplicação com aprovação específica.
- Publicação de `ulbra-conversa`, segredo `ULBRA_TOKENS_CHAVE`, merge da PR, ativação de flags: cada um com aprovação específica.
- Coerência dos cinco artefatos quando houver descoberta Prime: revisão humana (ver README).

## Decisões de 17/11/2026 (piloto de leitura, rodada de conclusão)

- **Dono da carteira = caso ativo.** Caso encerrado (`caso_encerrado_operacional` verdadeiro) não autoriza leitura do antigo dono. Se a verificação de qualquer caso falhar, ninguém é dono (fail-closed: `donosDoAluno` devolve lista vazia). Implementado em `index.ts` (`donosDoAluno`); provado em `index-handler.test.ts` (casos g e i; i discrimina o fail-open, conferido por mutação).
- **Responsável atual autoriza, independentemente da situação do caso**: `ulbra_atendimentos` não dispensado, comprovado pelo atendimento (regra dada pela gestão: "responsabilidade atual comprovada pelo atendimento"). Não há prova de que o atendimento encerra junto com o caso; isso não foi assumido. Se a gestão quiser o contrário, é decisão nova.
- **Leitura global mantida**: `amanda.seibel@aelbra.com.br` e `cobranca04@aelbra.com.br` (Fernanda), exigindo usuário ativo. Sem mudança nesta rodada.
- **Porta de tela (`HISTORICO_DISPONIVEL = true`) acompanha o merge.** O servidor é o portão: com `ULBRA_HISTORICO_HABILITADO` ausente, a capacidade é negada e nada chega à Mensageria (caso c1b). Não há mais passo de "ligar a porta" como etapa separada.
- **Contenção da v1 `ulbra-historico` está CONTIDA** (nos registros de 16/11 aparece como "A2" de v1; NÃO confundir com o "A2" de divergência de identidade do pacote). Função excluída, ausente da listagem, HTTP 404. Evidência preservada; não é pendência.
- **A3 (INSERT em `auditoria`)**: grant de INSERT para `authenticated` existe, mas a RLS nega a inserção direta (não há política permissiva de INSERT). Não bloqueia o piloto. A revogação do grant exige inventário completo dos inserts (até agora nenhum insert por sessão de usuário foi encontrado; `ProjecaoHoraHora.jsx` só lê). Correção mínima preparada para revisão, NÃO aplicada.
- **B5** (ordem de envio vs confirmação): a ordem ENVIANDO → enviar → gravar está em `envio.ts:215-237`; uma falha depois do envio deixa a linha em `FALHA_INCERTA`. É bloqueio obrigatório do envio real, separado do piloto de leitura. Não alterado nesta rodada; flags de envio continuam desligadas.

## Aceite pendente (registro formal; não aceito ainda)

- **Regra dos cinco — alcance.** Texto exato para aceite formal:
  > "Mensageria não exige atualização artificial dos artefatos Prime (prime-api.md, prime-api-catalog.json, prime-mapa-fontes-verdade.md, prime-mapa-identificadores.md, prime-gaps.md). Mudanças Prime continuam sujeitas à regra dos cinco e à revisão de coerência."
  - Origem: decisão da gestão nesta sessão de trabalho. Aceite formal da gestão: PENDENTE.
  - Conversa não é fonte primária pelo CLAUDE.md, item 4. Por isso a decisão precisa de registro formal assinado pela gestão antes de ser tratada como definitiva.
