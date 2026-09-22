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
