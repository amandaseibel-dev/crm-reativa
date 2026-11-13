# Aba Jurídico — seleção, bloqueio e encaminhamento (12/11/2026)

Migration `20261112180000_juridico_encaminhamento.sql` — **não aplicada**. Aplicar exige
autorização específica (RUNBOOK-MIGRATIONS).

## Fluxo

| Etapa | RPC | Efeito |
|---|---|---|
| Ver candidatos | `juridico_candidatos` | leitura; nada gravado |
| Gerar lista preliminar | `juridico_lote_gerar` | cria lote com protocolo `JUR-AAAAMMDD-NNNN` e casos `EM_ANALISE` |
| Substituir / remover | `juridico_caso_substituir`, `juridico_caso_remover` | caso vira `REMOVIDO` (fica no histórico); substituir traz o próximo do mesmo critério |
| Documento | `juridico_caso_documento_vincular`, `juridico_caso_autorizar_documento` | registra link/localização do termo ou a autorização do jurídico |
| Acordo ativo | `juridico_caso_aprovar_acordo_ativo` | aprovação específica, com motivo |
| Aprovar | `juridico_caso_aprovar` | fotografa os títulos e **bloqueia a cobrança** |
| Excel + envio | `juridico_lote_enviar_financeiro`, `juridico_lote_exportar` | `APROVADO → ENVIADO_FINANCEIRO`; Excel só com aprovados |
| Confirmar | `juridico_casos_confirmar_juridico` | `ENVIADO_FINANCEIRO → CONFIRMADO_JURIDICO` (encaminhado; **não** é ajuizamento) |

Toda RPC confere `usuario_e_gestao()`. As cinco tabelas `juridico_*` têm RLS ligada, sem
policy e sem grant: só se lê e escreve pelas RPCs.

## Regras medidas, não presumidas

- **Carteira**: mensalidade `ABERTO`, vencida, com vencimento a partir de 01/01/2025, mais
  parcelas vivas de acordo `ATIVO` com parcela vencida ("quebrado").
- **Sem duplicar**: mensalidade `NEGOCIADO` ou vinculada a acordo não cancelado
  (`acordo_titulo_vinculo`) aparece na conferência e **não soma** — soma a parcela.
- **Grupos** (por `alunos.situacao_academica`): Formado/Concluído → `FORMADO`;
  Trancado/Trancamento Institucional → `TRANCADO`; Cancelado/Desvinculado/Cancelamento
  Institucional → `EVADIDO`. "Término do Contrato" (3.915 alunos) **não** foi classificado
  como evadido — decisão da gestão.
- **Período do formado**: a base não guarda data de conclusão (`alunos.semestre` é nulo nos
  formados; `prime_academico_vinculo` só tem `graduated`). O filtro de ano/semestre usa
  `alunos.semestre_divida`.
- **Fora da seleção**: aluno já em lote vivo, com bloqueio administrativo, com título
  `EM_CONFIRMACAO` ou solicitação de confirmação de pagamento pendente.

## Bloqueio — por que não há mecanismo novo

A aprovação grava `JURIDICO` em `alunos.status_atual`, `status_jornada` e
`status_acionamento`, como a tabulação JURIDICO (só-gestão) já faz: 65 dos 69 alunos em
jurídico em produção em 12/11/2026 têm o código nas três colunas. Quem já lê esse estado:

| Caminho de cobrança | Onde é barrado |
|---|---|
| Massivas e elegibilidade | `aluno_bloqueio_administrativo` → `aluno_elegibilidade_cobranca` |
| Fila, giro, nivelamento, redistribuição | `alunos_propaga_encerramento_para_caso` → `casos.encerrado_operacional` |
| Alertas automáticos D-2 | `aluno_bloqueado_para_d2` |
| Acionamento manual na ficha | `STATUS_BLOQUEADOS_ACIONAMENTO` (lê `status_jornada`) + gatilho `_encerramento_so_gestao` |

O bloqueio é **por aluno**: todos os títulos dele saem da cobrança, não só os aprovados.
Nenhuma linha de `acordos_titulos`, `parcelas` ou `acordos` é escrita. O estado anterior
fica em `juridico_casos.bloqueio_anterior` e é restaurado por `juridico_caso_remover`
enquanto o caso está `APROVADO`. Depois do envio ao financeiro a aba não desfaz.

Fail-closed: se a tabulação JURIDICO ganhar `efeito_desfecho` ou `redireciona_para_email`,
a aprovação recusa (os gatilhos de `status_jornada` passariam a ter efeito financeiro).

## Auditoria do Guardião (12/11/2026) — o que foi corrigido e o que fica

Corrigido: o envio ao financeiro **reconfere** cada título e parcela da fotografia e recusa,
nomeando o aluno, se algum deixou de estar em aberto depois da aprovação; o corte de
vencimento usa o dia de São Paulo; a sequence da identidade do histórico perdeu os grants.

Conferido em produção (leitura, 12/11/2026): `termos_acordo.aluno_id` é `text`, como a
conferência compara.

Fica, por decisão a tomar pela gestão:

- **CPF completo** no retorno de `juridico_lote_enviar_financeiro` e `juridico_lote_exportar`:
  é exceção à regra de CPF mascarado, porque o financeiro precisa dele no Excel. Só gestão
  chama, e cada geração fica em `juridico_historico` (`EXCEL_GERADO`). O painel não devolve CPF.
- **Quem é gestão**: `usuario_e_gestao()` inclui os três logins (Amanda, Fernanda, Amanda ADM).
- **O bloqueio é travado no banco** (segunda rodada): nem a gestão tira o `JURIDICO` por outra tela;
  a saída é remover o caso na aba.
- Rollback só é possível antes do primeiro envio ao financeiro.

## Segunda rodada (autorizada em 12/11/2026, só na #934)

- **Guarda do bloqueio no banco**: `_juridico_guarda_bloqueio` (gatilhos em `alunos` e `casos`)
  recusa tirar `JURIDICO` de qualquer coluna de status enquanto houver caso APROVADO, ENVIADO
  ou CONFIRMADO. A única saída é `juridico_caso_remover`, que liga a GUC `juridico.desbloqueio`
  dentro da transação e registra o motivo e o estado anterior.
- **Caso de cobrança novo para aluno com encaminhamento ativo** é recusado no insert em `casos`.
- **Pagamento não baixado** bloqueia a seleção, a aprovação (`!PAGAMENTO_NAO_BAIXADO`) e o envio.
  Sinais: pagamento registrado contra título aberto; contra boleto de parcela viva; e extrato Prime
  pela regra **por título** das Ações Massivas (último registro do boleto+CPF, título aberto,
  liquidado mais de 30 dias após o vencimento e depois da importação, com valor pago).
  **Medido em produção em 12/11/2026 (leitura, consultas em
  `docs/juridico/consultas-n1-n4-2026-11-12.sql`):** universo de 2.640 alunos (R$ 8,52 mi em
  aberto, antes do filtro de pagamento); a regra atual barra 24 (2 formados, 6 trancados, 16
  evadidos; R$ 56.558,17) e o portão canônico retira outros 4. Ficam 2.613 elegíveis.
  Regra antiga e atual, sobre o universo de 2.640 alunos:

  | | Regra antiga | Regra atual |
  |---|---|---|
  | Impedidos por pagamento não baixado | 2.382 | 24 |
  | Elegíveis antes do portão | 258 | 2.616 |
  | Elegíveis depois do portão canônico (4 retirados) | — | **2.613** (R$ 8,44 mi) |

  Os 2.346 alunos da diferença deixam de ser impedidos com a regra atual: o prazo de 30 dias
  **libera** esses alunos, porque o pagamento no extrato ocorreu mais de 30 dias após o
  vencimento e depois da importação do título. Alunos barrados hoje (27 no total, contando o
  portão): 2 formados, 6 trancados e 16 evadidos por pagamento não baixado, e 4 pelo portão.

  Decomposição CUMULATIVA da redução de 2.382 para 24, na ordem abaixo (o efeito isolado de
  cada mudança não foi medido; mudar a ordem muda a atribuição):
  - NEGOCIADO no sinal (a): **0 alunos** (não muda nada hoje);
  - NEGOCIADO no sinal (c): **12 alunos** liberados pela regra atual, todos com acordo ATIVO
    quebrado (liquidação de título negociado é o acordo, não pagamento). Restaurar NEGOCIADO
    no sinal (c) os barraria de novo;
  - prazo de 30 dias e data de criação do título no sinal (c): **2.346 alunos liberados**;
  - último registro do extrato (em vez de qualquer linha): **0 alunos** hoje.
  O critério de 30 dias **não foi alterado**: depende de decisão expressa da gestão.
  Os números antigos (2.597 candidatos, 2.368 barrados, 26 e R$ 7,72 mi) não batem com esta
  medição e não foram reconciliados; não usar.
  Diferenças reais para as Ações Massivas: aqui basta **um** título pago; lá exige todos os
  títulos liquidados e pelo menos 50% pago. A massiva também não encaminha aluno com acordo
  cancelado; o Jurídico não tem essa exclusão.
- **Acordo novo ou reativado depois da aprovação** (`ACORDO_NOVO`): a aprovação grava em
  `juridico_casos.acordos_aprovados` os IDs de todos os acordos ATIVOS do aluno. Depois, qualquer
  acordo ATIVO fora desse conjunto gera a divergência. Não usa `criado_em` nem `atualizado_em`.
  Acordo cancelado depois da aprovação e reativado com o mesmo ID: o gatilho
  `trg_juridico_acordo_status` grava cada mudança de status em `juridico_historico`
  (evento `ACORDO_STATUS`) e a divergência `ACORDO_REATIVADO` lê esse histórico.
  Não movimenta carteira nem altera acordo; o envio fica recusado até a gestão revisar.
- **Acordo QUEBRADO** (decisão da gestão, PR #934): o aluno entra na lista, mas a pendência
  `ACORDO_QUEBRADO_SEM_REVISAO` impede a aprovação e o encaminhamento. A revisão
  (`juridico_caso_revisar_acordo_quebrado`) exige a lista e o saldo exigível que a gestão viu, a
  justificativa, e recusa se houver pagamento pendente ou não baixado. Grava quem, quando e por quê
  (`quebrado_revisado_*`). Não cobra, não cancela, não move carteira nem responsável. A pendência
  volta se o conjunto ou o saldo mudar; some se o acordo for regularizado, cancelado ou quitado.
  Mensalidades incorporadas ao acordo não entram de novo no caso.
  Depois da aprovação, acordo que quebra sem revisão que bata vira a divergência
  `ACORDO_QUEBRADO_SEM_REVISAO` e o envio ao financeiro é recusado. O conjunto e o saldo dos
  quebrados vêm prontos da conferência (`quebrados.ids`, `quebrados.saldo`); a tela não soma.
  Acordo que fica em dia depois da aprovação, sem a aprovação específica de acordo ativo, vira a
  divergência `ACORDO_ATIVO_SEM_APROVACAO` e o envio é recusado. Em caso já enviado ou confirmado,
  essas divergências são só alerta para a gestão: não há revisão nem remoção pela aba.
  **Divergências impeditivas depois da aprovação (decisão da gestão):** todas recusam o envio ao
  financeiro e aparecem no painel, no alerta e no Excel; a saída é remover o caso (o que libera o
  aluno) e gerar nova seleção, com nova conferência. Nenhuma altera responsável, carteira,
  fidelização, cobrança ou encerramento.
  - `TERMO_INVALIDADO`: caso aprovado com acordo, sem documento vinculado nem autorização jurídica,
    cujo termo foi rejeitado, removido ou deixou de estar na etapa COMPLETO com arquivo final.
  - `TITULO_EM_CONFIRMACAO`: qualquer título do aluno em `EM_CONFIRMACAO`, esteja ou não na
    fotografia. Lido do estado efetivo do banco a cada conferência.
  - `ACORDO_CONDICOES_ALTERADAS`: a assinatura dos acordos ativos (valor total, nº de parcelas,
    forma e entrada, e número, valor, vencimento e boleto de cada parcela) difere da gravada na
    aprovação, mesmo com os mesmos IDs e saldo. Observação, responsável e datas de atualização
    não contam; o status da parcela também não (pagamento e quebra têm divergência própria).
  - Excel: coluna "Conferência" = Conferido (nada mudou), Revisão necessária (termo, condições,
    acordo novo/reativado, quebrado ou ativo sem aprovação) ou Não encaminhável (pagamento,
    título em confirmação, mensalidade ou parcela alterada). Com divergência, o texto "Conferido
    no CRM" não é usado. "Aprovado por" e "Aprovado em" preservam o histórico da aprovação.
  - Desempenho: três consultas por caso, todas por `aluno_id` com índice existente em produção
    (`acordos_aluno_id_idx`, `parcelas_acordo_id_idx`, `ix_termos_acordo_aluno`,
    `ix_acordos_titulos_em_confirmacao_aluno` parcial). Custo medido: NÃO MEDIDO em produção.
  Riscos residuais: (1) acordo regularizado sem pagamento volta a quebrar com as mesmas
  condições e o mesmo saldo: não pede nova revisão; (2) mudança de parcela por outra transação
  durante a aprovação não é travada (sem lock em `parcelas`) e não há teste de concorrência
  real (PGlite é sessão única); (3) termo avaliado só pela etapa e pelo arquivo, não pelo
  conteúdo.
- **Acordo ativo novo ou reativado depois da geração da lista** (`ACORDO_NOVO_APOS_GERACAO`):
  a pendência recusa a aprovação. A base revisada é `juridico_casos.acordos_na_geracao` (gravada na
  geração e renovada só pela aprovação específica de acordo ativo, com motivo). A aprovação trava o
  conjunto de acordos ativos antes da conferência e recusa se a fotografia trouxer acordo fora dele.
  Limite: o PGlite não reproduz a corrida entre duas conexões; o lock `FOR UPDATE` trava só as linhas ATIVO já existentes. Não cobre INSERT concorrente nem a transição CANCELADO→ATIVO feita por outra transação ainda não confirmada. A detecção depois da aprovação (`ACORDO_NOVO`, `ACORDO_REATIVADO`) é a rede de proteção.
- **Envio recusa** qualquer caso com divergência: mensalidade ou parcela que mudou, valor
  diferente do aprovado, acordo duplicado, pagamento não baixado ou aguardando confirmação.
- **Alerta**: `juridico_varrer_alertas` registra `ALERTA_DIVERGENCIA` no histórico do caso
  quando surge mudança depois do encaminhamento (idempotente). Não cancela nem reescreve nada.
  A tela mostra as divergências em cada caso. **Não há envio de e-mail ou mensagem**: o sistema
  não tem canal com o jurídico; o aviso fica na aba e no histórico.
- **Confirmação ao jurídico** não aceita data futura (horário de São Paulo).
- **Documentos**: `juridico_documentos` guarda cada vínculo (append-only). Só se vincula com o
  caso em análise ou aprovado.
- **Histórico** (`juridico_historico`) e `juridico_documentos` recusam UPDATE, DELETE e TRUNCATE.
- **Excel**: toda geração (envio e reexportação) registra `EXCEL_GERADO` com o lote. Só leva caso
  enviado ou confirmado. Os valores são os da aprovação; a coluna "Situação na data da geração"
  marca o caso em que algo mudou depois.
- **Grants e rollback**: listas explícitas de 14 funções públicas e 16 internas (sem `service_role`); a
  migration confere que o inventário tem exatamente 30. O rollback solta gatilhos, depois as 30 funções,
  depois as tabelas. Cópias em `_backup_juridico_*_20261112` com RLS e sem grant.
- **Término do Contrato** não entra em evadidos (`_juridico_grupo` devolve nulo).

## O que não está nesta entrega

- Busca automática do termo cobre os anexos do CRM (`termos_acordo`, `casos.termo_url`).
  Drive e outros repositórios entram por vínculo manual (link/localização); não há upload
  de arquivo pela aba.
- Registro de ajuizamento efetivo e retorno do jurídico.
- Os painéis de estoque de carteira continuam somando a dívida do aluno em jurídico, como
  já fazem hoje com os 69 existentes.

## Rollback

`supabase/rollbacks/20261112180000_juridico_encaminhamento.rollback.sql` — recusa rodar
enquanto houver caso com cobrança bloqueada pela aba; guarda cópia das cinco tabelas.
