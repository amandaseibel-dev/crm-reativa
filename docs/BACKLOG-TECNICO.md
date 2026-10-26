# Backlog técnico

## Journal de `saldo_total` por aluno (aberto em 11/09/2026)

**Prioridade:** alta para auditoria financeira · **origem:** reconciliação das
513 fichas criadas em 11/09.

Hoje **nenhuma alteração de saldo é journalizada por aluno**. Para fechar a
conta daquele lote tive que reconstruir o "antes" por agregado, porque:

- `alunos_estado_anterior` existe e é alimentada pelo gatilho
  `trg_aluno_estado_anterior`, mas o JSON de `estado` **não carrega
  `saldo_total`**;
- `audit_log` não tem linhas de `alunos` nem de `casos` para a janela do lote
  (as duas tabelas não são auditadas nessa operação);
- a única série temporal de saldo que existe é `fluxo_pagamentos_execucoes`
  (`carteira_antes` / `carteira_depois`), que é **agregada da base inteira**,
  de hora em hora — serve para medir o efeito de um lote, não para explicar
  um aluno.

Consequência prática: dá para provar *quanto* a carteira mudou, mas não *qual
aluno* mudou nem *por quê*, a não ser por dedução.

**O que resolveria**, em ordem de custo:

1. incluir `saldo_total`, `saldo_vencido` e `situacao_operacional` no `estado`
   gravado por `_trg_aluno_estado_anterior` — mudança pequena, resolve a maior
   parte dos casos;
2. tabela dedicada `aluno_saldo_historico (aluno_id, saldo_antes, saldo_depois,
   origem, lote, em)` escrita por `recalcular_situacao_aluno`, que já é o único
   ponto que grava `alunos.saldo_total`;
3. expurgo por retenção, porque a tabela cresce junto com a virada diária
   (~12 mil recálculos/dia).

A opção 2 é a que permite reconstruir qualquer mudança financeira sem depender
de agregado. A opção 1 é o remendo barato.

**Não implementar sem aprovação.** Registrado aqui por decisão da Amanda em
11/09/2026: "precisamos futuramente journalizar alterações de saldo para
conseguirmos reconstruir qualquer mudança financeira sem depender de agregados".

## Outros itens levantados na auditoria de 11/09 e ainda não endereçados

- **794 tabelas `_backup_*`** no schema `public`, +72/dia: `fluxo_pagamentos_rodar`
  cria 3 por hora mesmo processando zero linhas. Expurgo por retenção + só
  gerar backup quando a etapa tocar alguma linha.
- ~~**6 Edge Functions em produção fora do repositório**: `prime-extrato`,
  `prime-acordo`, `prime-titular`, `prime-buscar-nome`, `prime-sonda`,
  `exportar-gestao`.~~ — **VERSIONADAS em 22/09/2026** (mapeamento estrutural
  da integração Prime/ULBRA), código idêntico ao de produção, nenhum deploy
  novo feito. Ver `docs/integracoes/prime-edge-functions.md`.

## Drift de banco: RPC e tabelas só em produção (descoberto 22/09/2026)

Achado durante o mapeamento estrutural da integração Prime/ULBRA — não
corrigido, é mapeamento, não é hora de aplicar migration em produção.

- `public.prime_chave_api()` existe em produção e não tem migration no
  repositório. É funcionalmente idêntica a `public.prime_api_key_backend()`,
  que **está** versionada — duas RPCs fazendo a mesma coisa (ler
  `vault.decrypted_secrets`/`prime_api_key`, restrito a `service_role`), uma
  delas invisível ao `git log`.
- `public.prime_extrato` e `public.prime_extrato_fila` existem em produção
  (confirmado por `information_schema.columns`), alimentam a Edge Function
  `prime-extrato` (agora versionada), e **nenhuma migration do repositório
  contém o `CREATE TABLE`** de nenhuma das duas.
- `public.prime_mensalidades_sync` é tabela órfã: existe em produção, tem a
  coluna `is_agreement` (o campo que se esperava usar para achar parcela de
  acordo), está **vazia**, e tem **zero ocorrências** em todo o repositório —
  nem migration, nem código. Provavelmente substituída por `prime_extrato`
  sem que a tabela antiga fosse removida.

**Correção sugerida (NÃO aplicada — depende de autorização):** uma migration
`CREATE TABLE IF NOT EXISTS` reconciliando `prime_extrato` e
`prime_extrato_fila` com o schema real de produção, e decidir entre manter
`prime_chave_api()`/`prime_api_key_backend()` como uma só função ou registrar
formalmente as duas. `prime_mensalidades_sync` candidata a `DROP` depois de
confirmar que nada em produção ainda a referencia fora do repositório.

Ver `docs/integracoes/prime-gaps.md` para o detalhe completo.
- **`invariante_config`**: 2 invariantes seguem desligados de propósito
  (`parcela_paga_sem_pagamento`, `parcela_documento_de_outro_aluno`) e 1 foi
  desligado em 11/09 por redundância (`boleto_amarrado_na_parcela_errada`).
- **Invariante sugerido, não implementado**: 183 prefixos de boleto
  compartilhados por dois ou mais acordos (um número Ulbra sob dois acordos do
  CRM). Guardado para a próxima rodada.
- **`saldo_total` não é confiável para aluno sem ficha**: a virada diária varre
  `casos`, então quem não tem ficha nunca é recalculado. Medido em 11/09: a
  `vw_alunos_sem_caso_com_divida` encontra 3 alunos com dívida canônica, mas
  apenas 1 deles tem `alunos.saldo_total > 0`.

## 317 tabelas `_backup_baixa_relatorio_%` acumuladas (descoberto 12/09/2026)

`trg_pagamentos_baixar_lote` é FOR EACH STATEMENT em `pagamentos` e chama
`baixa_pelo_relatorio_pagamento(true, current_date - 180)`. Essa função faz
`create table if not exists public._backup_baixa_relatorio_<timestamp> as select ...`
**antes** de saber se há algo a baixar. Como o nome carrega o timestamp, cada
importação deixa uma tabela nova — hoje são **317**, a maioria vazia.

Não é urgente e não afeta número nenhum, mas:
* ocupa entrada no catálogo e aparece em qualquer varredura de RLS;
* dificulta achar o backup que importa quando um reparo precisa ser revertido.

Correção sugerida (não aplicada): criar o backup só quando `_brp_casa` tiver
linhas, e varrer as vazias com mais de 30 dias.

## A mesma rotina de baixa roda duas vezes por caminhos diferentes

`baixa_pelo_relatorio_pagamento(true, -180d)` é chamada pelo cron horário
`fluxo_pagamentos_horario` **e** pelo gatilho de statement de `pagamentos`. Hoje
isso é inofensivo porque a fila de casamento boleto-a-boleto está em zero, mas
significa que qualquer importação dispara uma varredura de 180 dias, não só das
linhas que acabaram de entrar. Medido em 12/09/2026 13:05: a varredura baixaria
**0 parcelas** (1 recusa por "pagou muito mais").

## P0 DE PERMISSÃO: `fluxo_pagamentos_rodar` é chamável por qualquer usuário logado

Descoberto em 12/09/2026, auditando `prime_vincular_por_negociacao`.

`public.fluxo_pagamentos_rodar(p_origem text)` é `security definer`, tem
`EXECUTE` para o papel **`authenticated`**, e **não tem portão de permissão
próprio** — só o disjuntor de carga. A primeira coisa que ela faz é
`set_config('reativa.fluxo_pagamentos','on', true)`, que é exatamente a chave
que abre o portão de todas as rotinas financeiras internas:

* `baixa_pelo_relatorio_pagamento(true, current_date - 180)` — dá baixa;
* `prime_vincular_por_negociacao(true, 3)` — cria vínculo acordo × mensalidade;
* `recalcular_situacao_aluno` em cadeia — reescreve `alunos.saldo_total`.

Ou seja: **qualquer operador logado pode disparar o fluxo financeiro inteiro**
com um `supabase.rpc('fluxo_pagamentos_rodar')`. Não escolhe o que acontece, mas
dispara. É a mesma classe de defeito que a Fase 2A corrigiu em
`fluxo_acordos_rodar`.

Correção sugerida (NÃO aplicada — depende de autorização):

```sql
revoke all on function public.fluxo_pagamentos_rodar(text) from public, anon, authenticated;
```

Conferido em 12/09/2026: **nenhuma** tela em `src/` e nenhuma Edge Function
chama essa RPC, então revogar não quebra caminho de usuário. O cron roda como
dono e não é afetado.

Na mesma varredura: `pagamentos_sem_aluno(text)` também é `security definer`
com `EXECUTE` para `authenticated` e **sem portão interno** — qualquer logado
consegue listar nome, valor e operador dos pagamentos sem vínculo. Escrever já
é protegido (`pagamento_vincular_aluno` exige `usuario_e_gestao()`).

## 81 tabelas `_backup_vinc_negociacao_%` acumuladas

Mesmo padrão do `_backup_baixa_relatorio_%`: `prime_vincular_por_negociacao`
cria a tabela de backup antes de saber se há título a vincular, e o nome carrega
o timestamp. Rodando de hora em hora, são 81 tabelas (contadas em 12/09/2026
13:25 UTC) — quase todas vazias
(8 kB). As três úteis de hoje são `_backup_vinc_negociacao_20260912024025`,
`..._20260912034023` e `..._20260912044025`: são o ponto de restauração dos 82
vínculos criados entre 02:40 e 04:40.

## ~~A mesma porta existe em `acordo_reconstruir_cron()`~~ — RESOLVIDO 12/09/2026

Encontrado em 12/09/2026 na varredura que fechou `fluxo_pagamentos_rodar`, e
**fechado no mesmo dia** com autorização da gestão — migration
`20260912134610`. ACL final: `postgres=X/postgres | service_role=X/postgres`.
Fica registrado porque o *padrão* do defeito é o que importa, não a instância.

O padrão do defeito é idêntico. Existe uma função que faz o trabalho, com portão:

```sql
-- acordo_reconstruir_lote(int): tem portão
if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
   and coalesce(auth.role(),'') <> 'service_role'
   and not public.usuario_e_gestao() then
  raise exception 'Acesso negado.' using errcode='42501';
end if;
```

…e um invólucro `security definer` **sem portão nenhum** que simplesmente liga a
chave e chama a primeira:

```sql
-- acordo_reconstruir_cron(): NÃO tem portão
perform set_config('reativa.fluxo_pagamentos','on', true);
return public.acordo_reconstruir_lote(200);
```

`acordo_reconstruir_cron()` tem `EXECUTE` para **`authenticated`**, retorna
`jsonb` (logo é exposta pelo PostgREST) e **nenhum job do `pg_cron` a chama** —
é um ponto de entrada órfão. Qualquer usuário logado pode reconstruir 200
acordos com um `supabase.rpc('acordo_reconstruir_cron')`.

Correção aplicada:

```sql
revoke all on function public.acordo_reconstruir_cron() from public, anon, authenticated;
```

Antes de revogar, conferido: nenhum `cron.job`, nenhuma outra função do banco,
nenhum gatilho, nenhuma view/regra, nenhuma ocorrência em `src/` ou em
`supabase/functions/`, e nenhum registro de execução em `auditoria`. A função
**não foi executada** em nenhum momento da correção.

`acordo_reconstruir_lote(integer)` segue com `EXECUTE` para `authenticated` de
propósito: ela tem portão próprio, então chamada direta por operador já recebe
42501. O problema era só o invólucro.

A migration termina com uma varredura que **falha** se ainda existir invólucro
sem portão chamável por `authenticated` — hoje não existe.

### Não é exposição: `_pagamentos_baixar_lote`

Também liga a chave sem portão e também tem `EXECUTE` para `authenticated`, mas
retorna `trigger` — o PostgREST não expõe função de gatilho, e chamá-la fora do
contexto de trigger falha. Fica registrado para não ser "descoberta" de novo.

### A regra que sai daqui

Invólucro que liga `reativa.fluxo_pagamentos` é tão privilegiado quanto a rotina
que ele destrava. Ou o invólucro carrega o mesmo portão, ou não pode ter
`EXECUTE` para `authenticated`. Vale varrer periodicamente:

```sql
select p.proname, has_function_privilege('authenticated', p.oid, 'EXECUTE')
  from pg_proc p
 where p.prosrc like '%set_config%' and p.prosrc like '%reativa.fluxo_pagamentos%'
   and p.prosrc not like '%usuario_e_gestao%';
```

## `20261023004500` (#738) BLOQUEADA para aplicação (decidido 24/10/2026)

**Prioridade:** alta se a reserva de orçamento da rodada voltar à pauta ·
**origem:** Etapa 1 da conciliação inteligente (PR #752).

A migration `20261023004500_fluxo_incremental_reserva_bloqueado.sql` recria
`fluxo_pagamentos_incremental` com o corpo inteiro e **não** traz o predicado
`ENCERRADO_SEM_EFEITO_FINANCEIRO` do contador `v_pend`. Aplicada depois de
`20261024170000_conciliacao_saida_terminal`, ela apaga essa correção em
silêncio: nada falha, e `pendentes` volta a contar quem já foi encerrado sem
efeito financeiro.

Não está aplicada em produção (conferido em 24/10/2026: a versão não existe em
`schema_migrations`, o corpo vivo tem `md5(prosrc) = 11c14ef5…` e
`position('v_reserva')` = 0). O arquivo **não** pode ser corrigido: está
mesclado na `main` e a catraca das migrations recusa alterar migration que já
existe no branch base.

**Enquanto não for aplicada:** nada a fazer. A catraca
`supabase/tests/contador_pendentes_nao_regride.test.js` declara a #738 como
BLOQUEADA e reprova qualquer migration posterior que recrie a função sem o
predicado.

**Quando for aplicada:** promover
`supabase/propostas/PROPOSTA_contador_pendentes_apos_reserva_738.sql` para
`supabase/migrations/` com timestamp posterior, aplicar a #738 e depois a
complementar, e remover a entrada da lista `DECLARADAS` da catraca.

Detalhe completo em `docs/CONCILIACAO-INTELIGENTE-2026-10-24.md`, anexo
"A #738 fica BLOQUEADA para aplicação em produção".

## Próximas prioridades da conciliação financeira (registradas 26/10/2026)

**Origem:** autorização da Etapa 2 (encaminhamento). A gestão autorizou a Etapa
2 e pediu que estes quatro ficassem registrados como as prioridades seguintes —
**nenhum deles foi iniciado**, e cada um precisa de autorização própria e
executor único. Todas as medições abaixo são de 26/10/2026, em produção
(`ahattpqrjmhkzsmnbdzs`), somente leitura.

### 1. `PAGAMENTO_CONFIRMADO` sem prova de caixa

**Prioridade:** alta · **efeito financeiro:** nenhum (é rótulo) ·
**é correção de semântica, não de dinheiro.**

`_fechar_confirmacao_ao_zerar_saldo` grava `status = 'PAGAMENTO_CONFIRMADO'` em
`solicitacoes_confirmacao_pagamento` quando o aluno fica sem saldo em aberto.
Medido: **1.042 confirmações, R$ 1.346.190,64**, de 26/08 a 26/10/2026 (o
caminho está vivo), das quais **833 (R$ 1.080.509,31) sem nenhum pagamento
ligado** em `solicitacao_confirmacao_pagamentos`.

Quem lê "PAGAMENTO_CONFIRMADO" entende caixa comprovado, e aqui o fato é "ficou
sem saldo em aberto". O vocabulário correto **já existe e não é usado**:
`CONCLUIDA_SALDO_ZERO` (3.069 linhas) e `ENCERRADO_SALDO_ZERO` (2).

Não confundir com o furo do fluxo de confirmação, que **está fechado**: depois
da regra de 09/10/2026 (PR #663), 340 de 347 confirmações têm pagamento ligado
(98,0%), contra 335 de 3.854 antes (8,7%). Os 7 restantes são exatamente este
caminho de saldo-zero.

### 2. Detector de duplicidade ligado à importação

**Prioridade:** alta · **efeito financeiro:** nenhum (só sinaliza).

`pagamentos_detectar_suspeita_duplicidade(p_importacao_id)` existe e **nenhuma
função a chama** (medido: 0 chamadores em `pg_proc`).
`projecao_importar_pagamentos` não a invoca.
`pagamento_suspeita_duplicidade` tem **9 linhas, todas de 11/09/2026** — nenhuma
em 45 dias.

A etapa `sinalizar_duplicado` está `ligado = true` em `fluxo_pagamentos_config`,
e isso **não a executa**: quem lê a configuração é `fluxo_pagamentos_rodar`, no
job 38, `active = false` desde o incidente de 24/09. Os jobs ativos (73/74/75)
chamam `fluxo_pagamentos_incremental`, que **não lê a configuração** e só chama
`pagamento_conciliar_um`.

### 3. Digital e arquivo preservados na importação de pagamentos

**Prioridade:** média · **efeito financeiro:** nenhum (rastreabilidade).

`importacoes` não tem **nenhuma** das três colunas de proveniência (medido: 0 de
`arquivo_sha256`, `arquivo_path`, `arquivo_bytes`). A Edge Function
`santander-importar` **calcula** a digital do conteúdo, usa-a para recusar
divergência entre prévia e confirmação, devolve-a na resposta — e **descarta**.

O padrão já está em produção para a importação de acordos
(`importacoes_acordos`, as 3 colunas, migration `20261024114622`, PR #750): as 2
importações desde 24/10 têm digital e contagem de linhas. Falta aplicá-lo ao
arquivo de pagamentos.

Secundário, medido no caminho: **714 pagamentos (R$ 1.062.023,14)** têm
`importacao_id` nulo e por isso não aparecem na conferência por arquivo.

### 4. Relatório dos acordos ausentes

**Prioridade:** alta · **efeito financeiro:** nenhum (é leitura).

**186 acordos / 334 pagamentos / R$ 253.716,61** em `AGUARDANDO_ACORDO` sem
decisão, e **0 dos 186 existem em `acordos`** — o registro-pai não existe, então
não há onde pendurar composição. Era 175 / 319 / R$ 231.812,17 em 22/10: a fila
cresce ~R$ 5,5 mil/dia.

Decomposição (26/10/2026):

| | Acordos | Pagamentos | Valor |
|---|---:|---:|---:|
| Parcial, passa no teste de piso | 7 | 14 | R$ 5.612,98 |
| Parcial, refutado pelo piso | 31 | 60 | R$ 29.927,46 |
| Aluno existe, zero título livre | 119 | 216 | R$ 193.778,47 |
| Sem CPF no arquivo | 29 | 44 | R$ 24.397,70 |

**Por que a crítica por linha da #750 não cobre isto.** `importacao_acordo_critica`
mede o que ENTROU no arquivo e foi rejeitado — tem 2 linhas, ambas
`documento_invalido`. Os 186 acordos **nunca estiveram no arquivo**: o
"Relatório de Títulos em Aberto" é extração parcial, e ausência não gera
crítica. O relatório a criar é de ausência, por acordo esperado — conferência,
sem criar acordo nenhum.

**Pendência de documentação, anterior a qualquer pedido externo:**
`docs/rascunhos/PEDIDO-TI-ULBRA-ACORDOS-166.RASCUNHO.md` (não enviado, não
autorizado) afirma que o padrão `5 + acordo(6) + parcela(4)` foi "verificado em
9.086 pagamentos sem uma única exceção". A parte da **parcela** foi refutada em
23/10/2026: nenhuma convenção fixa explica mais de 56,3% das 14.488 parcelas e
11,5% não casam com nenhuma — só os 6 dígitos do acordo são confiáveis (99,6%).
Corrigir o rascunho **antes** de qualquer decisão de enviá-lo, e atualizar os
cinco arquivos de `docs/integracoes/` na mesma alteração, como o README exige.

## `ESCOLHER_ALUNO` retirada da Etapa 2 (decidido 26/10/2026)

**Prioridade:** média · **origem:** revisão da própria Etapa 2, antes de
qualquer PR · **efeito financeiro:** existe, e é esse o problema.

A Etapa 2 do encaminhamento ia oferecer duas ações. `ESCOLHER_ALUNO` (42
pagamentos, R$ 23.469,07) foi **retirada** e vira item próprio. Dois defeitos
medidos em 26/10/2026, não hipóteses:

**a) A porta daria baixa.** A única função que executaria a ação é
`pagamento_vincular_aluno`, que chama `pagamento_conciliar_um(p_pagamento_id,
true)` logo depois de vincular, com `p_aplicar = true`. Essa função tem 24.824
caracteres, toca `baixas_pagamento`, grava `origem_baixa_ref` e chama
`recalcular_situacao_aluno`. Medido: dos **212** pagamentos com
`origem_vinculo = 'GESTAO_MANUAL'`, **154 (R$ 166.312,94) terminaram em
`BAIXADO`** — 73%. Uma fachada que anunciasse `efeito_financeiro: false` nesse
caminho estaria mentindo.

**b) 32 dos 42 já têm aluno vinculado.** Os 42 estão todos em
`AGUARDANDO_ACORDO`, e 32 têm `aluno_id` preenchido. O projeto decidiu o
contrário em 16/09/2026, e está no código: `podeVincularAluno` devolve
`!item.tem_aluno`, com o comentário *"oferecer Vincular nessas linhas só daria a
chance de sobrescrever um vínculo correto"*; e a trava
`ALUNO_VINCULADO_SEM_PROVA_DUPLA` tem `acao: null` de propósito.
`pagamento_vincular_aluno` grava `aluno_id` sem bloquear quando já havia aluno —
ela só registra o anterior no retorno.

**Como o defeito passou desapercebido, para não repetir.** O teste de
comportamento **dublava** `pagamento_vincular_aluno`, e o dublê omitia a chamada
a `pagamento_conciliar_um`. O teste "não toca no dinheiro" ficou verde afirmando
algo que a função real não garante. A lição está escrita no cabeçalho de
`supabase/tests/conciliacao_encaminhamento_etapa2.test.js`: **dublê de função que
move dinheiro não prova ausência de efeito financeiro; ausência da função, sim.**
Na versão final a bancada não tem `pagamento_vincular_aluno`, e um teste afirma
essa ausência explicitamente.

**O que NÃO mudou.** A busca manual de aluno em `PagamentosSemAluno.jsx`, que já
chamava `pagamento_vincular_aluno` em produção antes desta frente, segue
intacta, com o próprio portão e o próprio aviso. A Etapa 2 apenas não abriu uma
segunda porta para ela. Os 42 continuam visíveis na fila e recebem, desta
interface, a recusa nomeada `ACAO_FORA_DO_ESCOPO_DESTA_ETAPA`.

**Para retomar**, o item precisa resolver, antes de qualquer tela: se vincular
aluno pode ou não acionar a baixa pela mesma transação (decisão de negócio, não
de código); e uma guarda para não sobrescrever vínculo existente, que hoje não
existe em `pagamento_vincular_aluno`.
