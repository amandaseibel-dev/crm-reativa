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

## LIGAÇÃO AOS ENVIOS (17/11/2026)

Ligado (com teste): `whatsapp-send` (texto) e `whatsapp-enviar-documento` (documento) chamam
`juridico_checar_envio` com o hash do conteúdo enviado ANTES do gateway e do upload.
Falha em qualquer etapa impede o envio (fail-closed). Só `service_role` executa a checagem.

Requisito obrigatório antes de habilitar envio real da ULBRA (#913, `ulbra-conversa`): ligar
`juridico_checar_envio` ao caminho de envio real, com `p_aluno` = `alunos.id` confirmado por leitura,
e hash SHA-256 hexadecimal igual ao da prévia. Hoje o envio da #913 está desligado.


## DISPONIBILIZAÇÃO BLOQUEADA (17/11/2026)

A aba Jurídico **não está disponível** (`JURIDICO_LIBERADO = false` em `src/App.jsx`). Motivo: o envio
por WhatsApp e o envio de documentos não distinguem finalidade (cobrança ou atendimento). NÃO VERIFICADO se um
aluno com bloqueio jurídico efetivo recebe mensagem pelo canal: a cadência e o gateway estão fora do repositório.

Decisão da gestão: aluno com bloqueio jurídico não recebe cobrança (manual, massiva, automática),
inclusive respostas e documentos de cobrança. Atendimento acadêmico ou administrativo continua possível.
Não se classifica finalidade por prazo de mensagem.

Exceção (implementada no banco e ligada aos caminhos de envio de texto e documento; testes do helper e do banco):
- `juridico_checar_envio(aluno, conversa, operador, tipo, hash)`: FAIL-CLOSED. Sem aluno identificado recusa
  (não cria vínculo). Sem bloqueio efetivo passa. Com bloqueio exige autorização vigente para aluno,
  conversa, TIPO (MENSAGEM ou DOCUMENTO) e HASH do conteúdo aprovado; uso único.
- `juridico_autorizar_envio(aluno, conversa, tipo, hash, motivo)`: só gestão ativa; valida 30 minutos.
- Operador não escolhe finalidade. Alterar o conteúdo (outro hash) exige nova autorização. Cobrança permanece
  bloqueada. Autorização não remove o bloqueio nem altera carteira, responsável ou status do caso.
- Ligação feita: `whatsapp-send` (texto) chama a checagem antes do preparo; `whatsapp-enviar-documento`
  (documento) antes do preparo e do upload. A prova de execução é o CI, não o helper.

## IMPLANTAÇÃO E RECUPERAÇÃO (contagens do código e versões de produção medidas em 18/11/2026)

Conteúdo da migration `supabase/migrations/20261112180000_juridico_encaminhamento.sql` (contado no arquivo):
- 40 funções do módulo (a própria migration confere `v_n <> 40`).
- 6 tabelas `public.juridico_*` (lotes, casos, casos_titulos, historico, documentos, envio_autorizacoes).
- Gatilhos do módulo: `trg_juridico_so_anexa_historico`, `trg_juridico_so_anexa_documentos`,
  `trg_juridico_so_anexa_truncate_historico`, `trg_juridico_so_anexa_truncate_documentos`,
  `trg_juridico_acordo_status` (acordos), `trg_juridico_parcela_historico` (parcelas),
  `trg_juridico_marca_bloqueio_compartilhado` e `trg_juridico_guarda_nao_acionar` (casos),
  `trg_juridico_guarda_bloqueio` (alunos e casos), `trg_juridico_guarda_caso_novo` (casos),
  `trg_juridico_guarda_troca_aluno` (whatsapp_conversas; criado só se a tabela existir).

Versões de produção, por leitura (`list_edge_functions`, projeto ahattpqrjmhkzsmnbdzs):
- `whatsapp-send`: versão 23, última atualização em 2026-10-26, sem checagem jurídica.
- `whatsapp-enviar-documento`: versão 10, última atualização em 2026-08-22, sem checagem jurídica.
- O vínculo entre essas versões e um commit do git NÃO foi identificado por leitura. Precisa ser confirmado
  antes de qualquer rollback.
- Projetos visíveis nesta conta: um só (produção). Staging NÃO identificado; não foi usado.

Versões que andam juntas: a migration acima e as duas edges da MESMA revisão do branch, que chamam
`juridico_checar_envio` e `juridico_registrar_recusa_envio`. Com a #754, a revisão de integração fica no branch
local `feat/juridico-754-compat` (ainda não publicado), integrando a #754 (`wpp/v18-e-limites`, head 30c4e288).

Ordem de implantação (cada passo só com autorização):
1. Conferir por leitura, em cada ambiente: `schema_migrations` (versão ausente), `pg_proc` (contagem e
   `prosecdef`), `pg_trigger` (gatilhos acima) e o grant de `juridico_checar_envio` só para `service_role`.
2. Aplicar a migration.
3. Reconferir: 40 funções, os gatilhos listados e os grants.
4. Publicar `whatsapp-send` e `whatsapp-enviar-documento` JUNTAS, da revisão acima.
5. Validar os caminhos de envio em ambiente de teste (os handlers reais estão testados no CI em
   `supabase/functions/*/handlers.test.ts`, com transporte simulado).
6. Só então liberar a aba (`JURIDICO_LIBERADO`).

Recuperação:
- Edges novas no ar ANTES da migration: todo envio é recusado (RPC inexistente, fail-closed). Sem perda de dados.
  Recuperação: aplicar a migration e reconferir o passo 3.
- Migration aplicada e edges novas no ar: o bloqueio vale. Nenhum aluno bloqueado recebe envio sem autorização.
- Rollback da migration: NÃO executar com as edges novas no ar, porque `juridico_checar_envio` some e todo envio é
  recusado. Ordem obrigatória:
  (a) decisão da gestão sobre os alunos com bloqueio ativo;
  (b) republicar `whatsapp-send` na versão 23 e `whatsapp-enviar-documento` na versão 10 (o que está no ar hoje,
      sem checagem), após confirmar o vínculo com o código no git;
  (c) só então executar o rollback da migration.
  O rollback foi validado no banco de teste PGlite (describe "rollback"). Não validado em produção.
- Resultado incerto no gateway: a autorização já foi consumida. Não há reenvio automático. Nova autorização exige a gestão.

Identificação pelo telefone (medida em produção, leitura, 500 conversas mais recentes com `whatsapp_identificar_aluno`):
- 401 com `aluno_id`: 344 confirmadas pelo telefone; 52 sem prova (3 IDENTIFICADO com outro aluno, 41 de 46 MANUAL,
  6 NAO_ENCONTRADO, 2 AMBIGUO).
- Exigir prova para TODO envio afetaria essas 52 conversas, inclusive envio comum. Por isso a checagem exige prova
  só quando um aluno BLOQUEADO está envolvido (o vinculado, ou um que o telefone identifica, inclusive entre os
  candidatos de telefone ambíguo). Envio comum não muda. Essa garantia é do código; produção não foi reexecutada com
  a regra nova.
- Não provado por teste: a normalização de telefone e os telefones de responsáveis em produção. A fixture do
  banco de teste casa só `alunos.telefone`.

## ENVIO COM BLOQUEIO: ORDEM, RECUSA, RESULTADO INCERTO E #754 (18/11/2026)

- Ordem: a checagem roda ANTES do preparo (que assume a conversa e pode reatribuir aluno). O aluno vem
  SOMENTE de `whatsapp_conversas.aluno_id` da conversa existente (FK para alunos.id, confirmada por leitura
  na produção), nunca do corpo do pedido.
- Recusa jurídica (SQLSTATE próprio JUR01, não 42501): registrada na trilha do aluno como `JURIDICO_ENVIO_RECUSADO`, sem conteúdo e sem
  telefone. NÃO é registrada como falha do gateway. Erro de infraestrutura não é marcado como bloqueio.
- Documento: falha de upload, de URL assinada ou do Storage, depois da checagem, TAMBÉM gasta a autorização
  (nenhum caminho a libera). São recusas certas antes de qualquer envio, e a autorização se perde mesmo assim.
- Resultado incerto: a autorização é consumida ANTES da tentativa externa. Falha ou timeout do gateway NÃO
  gera reenvio automático e NÃO libera a autorização. Para enviar de novo, a gestão autoriza outro envio.
  Risco residual: o gateway pode ter entregue a mensagem e a resposta se perdido.
- Limitação TEMPORÁRIA para revisão (não decisão definitiva): contato novo é recusado mesmo com identificação
  segura, porque hoje não há caminho de identificação confiável para conversa nova.
  APROVAÇÃO REGISTRADA (indicada pela gestão nesta conversa; sem data de ata nem canal registrados): limitação TEMPORÁRIA. Contato novo ou conversa sem
  vínculo confiável com aluno não envia por este fluxo; nenhum vínculo é criado automaticamente. Recebimento e
  leitura: NÃO VERIFICADO no webhook (não lido). A passagem a definitiva depende de nova decisão da gestão, que segue PENDENTE. A aprovação
  existe apenas neste registro textual; canal e data da indicação NÃO estão registrados no repositório.
- Compatibilidade com a #754 (wpp/v18-e-limites): `git merge-file` com base da3d7aff, em `whatsapp-send/index.ts`.
  Medido em 18/11/2026 no head f5d2aa61: 3 regiões em conflito no padrão e 4 com `--diff3`. Regiões: import;
  constante MOTIVOS_DE_BLOQUEIO (a #754 a tira de index.ts e a move para bloqueio.ts); registro de bloqueio da
  cadência (reescrito pela #754). O bloco de checagem com `admin` não conflita. A #754 também traz bloqueio.ts e
  bloqueio.test.js. Quem integrar por último resolve, mantendo a checagem antes do preparo e os dois conjuntos de registro.
- `juridico_checar_envio(aluno, conversa, operador, tipo, hash)`: FAIL-CLOSED. Sem aluno identificado recusa
  (não cria vínculo). Sem bloqueio efetivo passa. Com bloqueio exige autorização vigente para aluno,
  conversa, TIPO (MENSAGEM ou DOCUMENTO) e HASH do conteúdo aprovado; uso único.
- `juridico_autorizar_envio(aluno, conversa, tipo, hash, motivo)`: só gestão ativa; valida 30 minutos.
- Operador não escolhe finalidade. Alterar o conteúdo (outro hash) exige nova autorização. Cobrança permanece
  bloqueada. Autorização não remove o bloqueio nem altera carteira, responsável ou status do caso.
- Ligação feita: `whatsapp-send` (texto) chama a checagem antes do preparo; `whatsapp-enviar-documento`
  (documento) antes do preparo e do upload. A prova de execução é o CI, não o helper.

## Atualização (17/11/2026): bloqueio por `nao_acionar`, carteira preservada

Decisão da gestão: aprovar bloqueia a cobrança, mas NÃO encerra o caso nem retira o aluno
da carteira. A seção abaixo, que grava `JURIDICO` em `alunos.status_*`, está **superada**.

- A aprovação liga `casos.nao_acionar` nos casos do aluno (estado anterior em
  `juridico_casos.bloqueio_anterior`). O portão `aluno_bloqueio_administrativo` devolve
  `NAO_ACIONAR_EXPLICITO`; cobrança, campanhas e massivas leem esse portão.
- Responsável, carteira, histórico, títulos e acordos ficam como estão. Nenhum status de
  aluno ou caso é gravado como `JURIDICO` pela aba.
- `_juridico_guarda_nao_acionar` (gatilho em `casos`) impede liberar o bloqueio fora da
  remoção do caso. A remoção restaura só o que este fluxo mudou; um bloqueio que já existia
  ou que veio depois (ex.: suspensão) continua valendo.
- `_juridico_divergencias` recusa o envio com `BLOQUEIO_PERDIDO` se o bloqueio cair.
- Os alunos com status `JURIDICO` gravado pela tabulação (histórico) não foram alterados.
- Não verificado no repositório: as rotinas de cadência WhatsApp e de tarefas leem
  `nao_acionar`. Nas funções versionadas, só giro, redistribuição e acionamento leem; as de
  cadência estão só em produção e não foram lidas.
- Remoção: retorna `bloqueio` = `LIBERADO` só quando nenhuma flag do aluno ficou ligada; caso contrário
  `MANTIDO_OUTRO_BLOQUEIO` (outro fluxo gravou a flag durante o encaminhamento, ou já havia bloqueio).
  Nem sempre a remoção libera: confira o retorno.
- Residual, não resolvido: (1) rollback não reconcilia flags de casos vivos (ele recusa
  com caso APROVADO; flags compartilhadas ficam ligadas por desenho); (2) o marcador é AFTER UPDATE (há teste sob espera: cenário 6 do runner): roda depois de a linha ser travada e lê o estado commitado. A ordem de travas é casos->juridico_casos, enquanto a remoção faz juridico_casos->casos (possível deadlock, não reproduzido). A guarda que impede liberar a flag continua BEFORE e não tem teste sob espera; (3) a prova de concorrência da aprovação não cobre o marcador.

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
enquanto o caso está `APROVADO` (seção superada abaixo: o bloqueio agora é `nao_acionar`). Depois do envio ao financeiro a aba não desfaz.

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
  financeiro e aparecem no painel, no alerta e no Excel; a saída é remover o caso (libera o bloqueio
  deste fluxo) e gerar nova seleção, com nova conferência. Nenhuma altera responsável, carteira,
  fidelização, cobrança ou encerramento.
  - `TERMO_INVALIDADO`: avalia o termo que SUSTENTOU a aprovação (`juridico_casos.termo_aprovado_id`,
    gravado na aprovação), não qualquer termo do aluno: rejeitado, removido ou fora da etapa
    COMPLETO com arquivo final gera a divergência. Termo novo pendente não alerta; se o aprovado é
    rejeitado, alerta mesmo existindo outro completo (nova conferência). A tabela de termos é
    chaveada por aluno, não por acordo; sem documento vinculado nem autorização o caso não é aprovado.
  - `TITULO_EM_CONFIRMACAO`: qualquer título do aluno em `EM_CONFIRMACAO`, esteja ou não na
    fotografia. Lido do estado efetivo do banco a cada conferência.
  - `ACORDO_CONDICOES_ALTERADAS`: a assinatura dos acordos ativos (valor total, nº de parcelas,
    forma, entrada arredondada a 2 casas, e número, valor e vencimento de cada parcela) difere da
    gravada na aprovação, OU houve alteração de valor/vencimento de parcela depois da aprovação,
    mesmo revertida (marca em `PARCELA_MATERIAL`). Boleto, observação, responsável, datas de
    atualização e status da parcela não contam.
  - Nova quebra: parcela que vira `VENCIDA` em acordo ativo de caso vivo grava `PARCELA_QUEBROU`
    (gatilho `trg_juridico_parcela_historico`, statement-level, saída imediata sem caso vivo). Depois
    da revisão (pendência) ou da aprovação (divergência), uma nova quebra volta a exigir revisão,
    mesmo com as mesmas condições e o mesmo saldo.
  - Concorrência na aprovação: aluno, acordos ativos e suas parcelas são travados (`FOR UPDATE`) e
    a assinatura é lida antes e depois da conferência; se mudou, a aprovação é recusada (40001).
    Mudança de termo entre a conferência e a aprovação não é travada (a divergência de termo
    pega depois). Sem teste de duas conexões reais (PGlite): a corrida é simulada por função que
    altera a parcela durante a conferência.
  - Confirmação jurídica: caso "Não encaminhável" NÃO é confirmado; grava `CONFIRMACAO_RECUSADA`
    no histórico com as divergências e a tela lista quem foi recusado e por quê. Os demais seguem;
    "Revisão necessária" segue e a divergência fica gravada no registro do encaminhamento.
  - Excel: coluna "Conferência" = Conferido (nada mudou), Revisão necessária (termo, condições,
    acordo novo/reativado, quebrado ou ativo sem aprovação) ou Não encaminhável (pagamento,
    título em confirmação, mensalidade ou parcela alterada). Com divergência, o texto "Conferido
    no CRM" não é usado. "Aprovado por" e "Aprovado em" preservam o histórico da aprovação.
  - Desempenho: o Excel calcula as divergências uma vez por caso (`offset 0` no lateral). Três consultas por caso, por `aluno_id`, com índice existente em produção
    (`acordos_aluno_id_idx`, `parcelas_acordo_id_idx`, `ix_termos_acordo_aluno`,
    `ix_acordos_titulos_em_confirmacao_aluno` parcial). Custo medido: NÃO MEDIDO em produção.
  Riscos residuais: (1) sem teste com duas conexões reais; (2) mudança de termo entre conferência e
  aprovação não é travada; (3) parcela reconstruída que soma 1 em `qtd_parcelas` gera
  `ACORDO_CONDICOES_ALTERADAS` (estrutura mudou de fato); (4) o gatilho de parcelas escreve no
  histórico por parcela alterada de caso vivo; custo em produção NÃO MEDIDO; (5) a única saída de
  uma divergência em caso já enviado é o alerta à gestão: não há revisão pela aba.
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
- **Grants e rollback**: listas explícitas de 14 funções públicas e 20 internas (sem `service_role`); a
  migration confere que o inventário tem exatamente 34. O rollback solta gatilhos, depois as 32 funções,
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


## Critério de data do pagamento no extrato Prime (vigente, não alterado)

O sinal de pagamento não baixado (c) usa o mesmo critério de data das Ações Massivas
(`acoes_massivas_liquidados_prime`): último registro do extrato do boleto+CPF, título ABERTO,
`liquidado_em > vencimento + 30` e `liquidado_em >= data de criação do título`. A conciliação Prime
(Grupo A) acrescenta `liquidado_em <> dia da importação`, `<= data da coleta` e `<= hoje`, além de
portador, CPF e corroboração. A diferença só no critério de data alcança 47 alunos / 61 títulos /
R$ 126.231,70 na base geral e nenhum aluno do universo atual do Jurídico
(`docs/juridico/IMPACTO-CRITERIO-DATA-2026-11-12.md`). Decisão separada da gestão; nada mudou.
Exemplo: título importado em 02/07/2026 com `liquidado_em` = 02/07/2026 conta como pagamento hoje
(barra o aluno); pela regra da conciliação seria artefato e não barraria.

## Concorrência real (Postgres 17, duas conexões)

Teste: `supabase/tests/juridico_concorrencia/run.mjs`, job `juridico-concorrencia` da CI
(postgres 17, banco descartável, dados sintéticos). O PGlite tem sessão única e não prova trava.

- **NOWAIT do aluno, dos acordos e das parcelas:** com a trava ocupada por outra sessão, a
  aprovação falha em menos de 2 segundos com `40001` ("Tente novamente em instantes"), sem
  nenhuma alteração parcial (caso, aluno, histórico e assinatura iguais ao estado anterior) e a
  nova tentativa passa depois que a outra sessão solta a trava.
- **Troca simultânea de parcelas vencidas do mesmo acordo:** uma sessão segura a primeira
  parcela e a outra espera pela segunda; a espera termina sem erro, e a marca
  `PARCELA_QUEBROU` existe.
- **Mutações (provam que o teste pega a regressão):** tirar o `NOWAIT` de alunos, de acordos ou
  de parcelas faz o cenário correspondente falhar: a verificação de tempo (< 2 s) reprova porque a aprovação esperou a trava. Tirar o
  limite de tempo do teste não bastaria: o `lock_timeout` viraria `55P03` e o bloco o converteria
  em `40001`; por isso a verificação de tempo está em cada cenário.
- **Leitura de produção (somente leitura):** gatilhos de `parcelas`, `acordos` e `alunos`
  listados; corpos de `_acordo_fecha_com_a_ultima_parcela`, `atualizar_parcelas_vencidas`,
  `_trg_recalc_por_parcela`, `_trg_recalc_por_aluno_uuid`, `recalcular_situacao_aluno` (corpo
  completo, lido em dois trechos) e `_reabrir_aluno_com_divida_nova`. Achado: os dois gatilhos de
  recálculo engolem qualquer erro (`exception when others then null`).

  **Espera limitada (corrigido):** as três RPCs que travam aluno e casos (`juridico_caso_aprovar`,
  `juridico_caso_aprovar_acordo_ativo`, `juridico_caso_revisar_acordo_quebrado`) passam a ter
  `set local lock_timeout = '3s'` e o corpo dentro de um bloco que converte `lock_not_available` em
  `40001` ("Caso em uso por outra rotina ... Nada foi gravado"). Assim nenhuma espera fica indefinida,
  inclusive a que nasce dentro de gatilho: o cascade `update alunos` -> `alunos_propaga_encerramento_para_caso`
  -> `update casos` está coberto pelo cenário 5 do teste. A transação é revertida inteira. O `NOWAIT`
  continua só em aluno, acordos e parcelas, onde foi testado. Não há prova de ausência de deadlock em
  ordem inversa de duas transações (comportamento pré-existente dos gatilhos): NÃO COMPROVADO.
  Residual (auditoria 1d1c1377): os gatilhos `_juridico_guarda_bloqueio` e `_juridico_guarda_caso_novo`
  levantam 42501 por linha. Um UPDATE ou INSERT em lote que atinja um único aluno com caso vivo aborta o
  comando inteiro (nada parcial). Comportamento intencional da guarda, a ser lembrado por quem roda lotes.

**Conjunto de dívidas elegíveis (X4, decidido pela gestão):** o conjunto é o das parcelas
VENCIDAS dos acordos ativos do aluno, gravado na revisão (`quebrado_revisado_parcelas`). Parcela nova
vencida que muda esse conjunto exige nova revisão, mesmo com saldo total igual (teste X1). Sem mudança
nenhuma, nenhum alerta (X2). Regularizar e quebrar de novo com o mesmo conjunto gera um único alerta,
sem duplicar (X2). Efeito: a quebra natural de uma parcela de acordo já revisado passa a exigir revisão
antes do envio (F4b) — decisão da gestão, que substitui a regra anterior.

**Critério de data (vigente, não alterado):** a diferença para o Prime e para as Ações Massivas
está na seção "Critério de data do pagamento no extrato Prime" acima.

### Declarações desta revisão (f0ae1a35)

- A recusa jurídica usa SQLSTATE próprio `JUR01`. `42501` continua significando permissão negada (infraestrutura).
- Iniciar conversa nova pelo front (`src/services/whatsapp.js`) passa a receber 403 para todos os operadores,
  porque conversa nova é recusada (o front não manda `conversa_id`). É efeito amplo e precisa de decisão de produto.
- Conversa sem `aluno_id` é RECUSADA para QUALQUER envio, com ou sem bloqueio jurídico (a checagem recusa aluno nulo).
  Essa recusa NÃO deixa trilha: `juridico_registrar_recusa_envio` retorna sem gravar quando o aluno é nulo.
  Isso é mais amplo que o bloqueio. A gestão indicou essa limitação como temporária (ver APROVAÇÃO REGISTRADA).
- A autorização é consumida na checagem, que roda ANTES do preparo. Portanto, uma recusa do preparo
  (responsável de outro operador, cadência, canal) também consome a autorização. Não há como desfazer.
- Ordem de implantação: a migration precisa estar aplicada antes das funções de envio. Função publicada
  antes da migration recusa todo envio (RPC inexistente, fail-closed).
- Não verificado: execução dos testes neste worktree (sem deno/vitest local nas funções); estado da migration
  na produção; DDL real de `aluno_movimentacoes`.
- Pré-existente, corrigido nesta revisão: `.catch` encadeado em `rpc()` no envio de documento.

### Contorno pela troca de vínculo (A1, reauditoria de 4838141d)

- `whatsapp_vincular_aluno` (migration 20260817120000) troca o aluno de uma conversa e não confere bloqueio.
  Fechado nesta revisão: gatilho `trg_juridico_guarda_troca_aluno` (erro JUR02) recusa trocar o aluno de conversa
  cujo aluno tem bloqueio efetivo. Não testado no PGlite (a fixture não tem `whatsapp_conversas`); CI não prova.
- Aberto: vincular uma conversa SEM aluno a um aluno sem bloqueio continua permitido pelo operador. Isso é
  afirmação de identidade pelo operador, do mesmo tipo do contato novo. Decisão da gestão pendente.
