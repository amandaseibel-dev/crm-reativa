# `acordos_pos_importacao` deixa de criar backup com TRUNCATE aberto

**Data:** 08/11/2026 · **Autorização da gestão:** 08/11/2026, com a condição
explícita de **menor alcance necessário** e de **não alterar globalmente
privilégios de outras tabelas sem avaliar efeitos**.
**Estado:** **PREPARADO, NÃO APLICADO.** Em produção só houve leitura de
catálogo. Nenhum TRUNCATE em produção.

| Arquivo | O que é |
|---|---|
| `supabase/aguardando_aprovacao/20261108120000_acordos_pos_importacao_sem_truncate.sql.pendente` | a migration |
| `supabase/aguardando_aprovacao/20261108120000_acordos_pos_importacao_sem_truncate.rollback.sql` | o rollback |
| `supabase/tests/acordos_pos_importacao_sem_truncate/` | fixtures e 7 + 2 casos |
| `.github/workflows/ci.yml` | job `acordos-pos-importacao-sem-truncate` |

Complementa o PR das 545 tabelas existentes
([`REVOKE-TRUNCATE-BACKUP-POS-IMPORT-2026-11-07.md`](REVOKE-TRUNCATE-BACKUP-POS-IMPORT-2026-11-07.md)).
**Aquele fecha o que existe; este fecha a origem.**

---

## 1. Correção de um registro anterior — a gravidade é menor do que eu disse

O documento de 07/11/2026 afirmava que **"qualquer token autenticado pode
chamá-la e criar uma `_backup_pos_import_*` nova"**. **Está errado.**

A leitura da função inteira (94 linhas, 4.420 bytes, uma única sobrecarga)
mostra portão interno nas primeiras linhas:

```sql
if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
   and coalesce(auth.role(),'') <> 'service_role'
   and not public.usuario_e_gestao() then
  raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
end if;
```

O `EXECUTE` para `authenticated` existe, mas **o corpo barra quem não é
gestão**. Chamar a função exige o GUC `reativa.fluxo_pagamentos='on'`, **ou**
`service_role`, **ou** passar por `usuario_e_gestao()`.

**Consequência honesta:** a porta que recria o grant está **atrás do portão da
gestão**, não aberta a qualquer token. Isso reduz a gravidade do item 4 do §5
do outro documento. Ainda vale fechar — uma tabela de lastro financeiro não
deveria nascer esvaziável por `authenticated`, independentemente de quem a
criou — mas é **higiene de privilégio**, não contenção de risco iminente.

---

## 2. O que a migration faz

Acrescenta **uma linha** (mais dois comentários) ao corpo, logo depois da linha
que liga a RLS na tabela recém-criada:

```sql
execute format('revoke truncate on table public.%I from authenticated',
               '_backup_pos_import_' || v_lote);
```

**Menor alcance possível, item por item:**

| Dimensão | Alcance |
|---|---|
| privilégio | **só** `TRUNCATE` |
| papel | **só** `authenticated` |
| tabela | **só** a que a própria função acabou de criar |
| tabelas existentes | **zero** tocadas |
| resto do schema `public` | **zero** efeito |
| lógica de negócio | **zero** linha alterada |
| RLS, policy, dado | **não** toca |

### Por que NÃO `alter default privileges`

Resolveria para toda tabela futura do schema com uma linha. Mas mudaria o
privilégio padrão de **todas** as tabelas novas de `public` — inclusive as de
código que ainda não existe — e exigiria varrer antes quem cria tabela em
runtime e se alguma rotina legítima depende de TRUNCATE em tabela nova. A
gestão pediu o menor alcance necessário e exigiu avaliar efeitos antes de mexer
em privilégio de outras tabelas. **Fica como decisão separada, não proposta
aqui.** O caso 5 do CI **falha** se o default do schema tiver sido alterado —
o alcance global é testado como regressão.

### Por que NÃO tirar o `EXECUTE` de `authenticated`

Porque o portão interno já barra, e remover o `EXECUTE` poderia derrubar
chamada legítima feita com token de gestão. Alcance maior, ganho duvidoso.

---

## 3. Como o patch é feito — sem transcrever o corpo

A migration **não reescreve** a função. Ela lê a definição real do catálogo com
`pg_get_functiondef()`, insere a linha depois da âncora e executa o texto
resultante. Ficam preservados **por construção**, não por cuidado manual:

- os **DEFAULT** dos argumentos (`p_importacao_id uuid DEFAULT NULL::uuid`,
  `p_confirmar boolean DEFAULT false`) — perdê-los quebraria quem chama a
  função com menos argumentos, e é o erro mais fácil de cometer aqui;
- `SECURITY DEFINER`, `SET search_path TO 'public'`,
  `SET statement_timeout TO '600s'`;
- volatilidade (`VOLATILE`), `parallel unsafe`, `cost 100`, retorno `jsonb`;
- o corpo byte a byte, fora da linha acrescentada.

**Três guardas**, todas falhando fechado:

1. **Idempotência** — recusa se o corpo já contiver `revoke truncate`.
2. **Âncora única** — a linha-âncora tem de aparecer **exatamente uma vez**.
   Zero significa que a função mudou; mais de uma, que o patch cairia em lugar
   ambíguo. Conferido contra produção em 08/11/2026: **aparece 1 vez**, e o
   corpo **não** contém `revoke`.
3. **Portão interno presente** — recusa se `usuario_e_gestao` tiver saído do
   corpo. A migration não é lugar de descobrir isso em silêncio.

**Grants (premissa §10).** `CREATE OR REPLACE` pode restaurar grants padrão.
A migration fotografa `proacl` antes e **aborta** se mudar. Hoje é
`postgres:EXECUTE, authenticated:EXECUTE, service_role:EXECUTE` — sem `anon`,
sem `PUBLIC`.

---

## 4. Teste: Postgres isolado no CI

Job `acordos-pos-importacao-sem-truncate`, mesmo padrão que já existia no
repositório (`services: postgres:16` + `psql`), **sem nada contratado a mais**.

### O fixture, e o que ele não é

`02_baseline.sql` instala uma função com o **mesmo nome, mesma assinatura,
mesmos DEFAULT, mesmos `SET`, mesmo portão interno e a mesma âncora byte a
byte** — mas com **corpo de negócio simplificado**. A lógica real (casamento de
parcela, `update` de situação, vínculos, `recalcular_situacao_aluno`) ficou de
fora **de propósito**: o patch não toca nela, reproduzi-la não provaria nada e
daria chance de divergir do real.

**O que isso significa, dito na cara:** o CI prova o **mecanismo do patch** e o
**resultado de privilégio**. **Não** prova a lógica de negócio da função real —
que o patch, por construção, não altera. O baseline **falha o CI** se o
ambiente não for fiel nos pontos que a migration confere (config, DEFAULT,
EXECUTE, âncora 1×).

### Os casos

Antes do patch, `02_baseline.sql` **demonstra o problema**: a função cria a
tabela, ela nasce com `D` no ACL, e `authenticated` **de fato a esvazia** com
TRUNCATE apesar da RLS ligada.

Depois do patch (`03_casos.sql`):

| # | Caso |
|---|---|
| 1 | `revoke truncate` está no corpo |
| 2 | **DEFAULT dos argumentos, `SECURITY DEFINER`, os dois `SET`, os três `EXECUTE` e o retorno `jsonb` intactos** |
| 3 | tabela nova nasce **sem** TRUNCATE, **com** RLS, mantendo `SELECT`/`INSERT`/`UPDATE`/`DELETE`; o TRUNCATE é **negado (42501)** e as linhas ficam |
| 4 | **alcance:** a tabela criada **antes** do patch segue intacta, ainda com TRUNCATE — esta migration não mexe em tabela existente |
| 5 | **alcance:** o **default privilege do schema não foi alterado** — tabela criada fora da função continua nascendo com TRUNCATE |
| 6 | `anon` sem alcance na tabela nova |
| 7 | o portão interno continua barrando quem não é gestão (42501) |

**Idempotência** é testada no próprio workflow: a segunda aplicação da
migration **tem de falhar**, ou o job falha.

Depois do rollback (`04_rollback.sql`): o corpo volta sem o `revoke`, a função
segue inteira, e — explicitamente — a tabela nova **volta a nascer com
TRUNCATE**. O rollback reabre o buraco, e isso está escrito no cabeçalho dele.

### Security Gate

Roda no mesmo job, contra o banco descartável. **Audita o fixture, não a
produção**: prova que o patch não introduz achado `BLOQUEIA` e que o gate
executa. Não substitui rodar o gate contra produção, que segue **NÃO
COMPROVADO** (`psql` ausente na máquina local).

---

## 5. O que fica sem teste — exatamente

1. **A migration nunca rodou contra o banco de produção.** O CI usa PG16 e uma
   função stand-in; produção é PG17 e a função real tem 94 linhas de negócio.
   O patch é feito sobre `pg_get_functiondef()` da função **real** no momento da
   aplicação, com guarda de âncora única — mas a aplicação em si não foi feita.
2. **A lógica de negócio da função real não foi exercitada**, nem antes nem
   depois. O patch não a altera, e o fixture não a reproduz.
3. **Nenhuma execução real de `acordos_pos_importacao` em produção** — nem para
   testar. Ela escreve em `acordos_titulos`, `parcelas` e
   `acordo_titulo_vinculo`: executá-la para testar seria alteração financeira,
   que exige autorização própria e tem executor único.
4. **Gate contra produção: NÃO COMPROVADO.**
5. **Matriz de perfis (§9) não executada**, por não se aplicar: nenhuma regra de
   acesso de operador, carteira, RPC ou view muda. O comportamento de
   `authenticated`, `anon` e do portão interno está nos casos 3, 6 e 7.

---

## 6. Checklist de deploy

**A. Gate automático** — roda no CI contra banco descartável, **0 BLOQUEIA**.
Contra produção: **NÃO COMPROVADO**.

**B. Critérios de interrupção** — nenhum disparado. **Não concede** nada a
`public`/`anon`/`authenticated`: só **retira** TRUNCATE de uma tabela nova.
Não desliga RLS, não cria view, não torna bucket público, não altera
mascaramento. **Alterações operacionais inesperadas: 0.**

**C. Migration** — **há `CREATE OR REPLACE` de função**, então os itens valem
e foram feitos: grants reconferidos (fotografia de `proacl`, aborta se mudar),
`search_path` fixo reconferido (`search_path=public`), autorização interna
presente e **testada** (caso 7), rollback preparado e testado no CI. ☑

**D. Teste de perfis (com ROLLBACK)** — **NÃO CONFERIDO** por não se aplicar;
o relevante está nos casos 3, 6 e 7.

**E. Dados pessoais / Storage** — não se aplica: nenhum dado, coluna, bucket ou
log tocado.

**F. Conclusão (§13)**

```
SEGURANÇA VALIDADA: [x] (leitura da função inteira + 9 casos em Postgres isolado)
PERFIS TESTADOS: [ ] NÃO CONFERIDO -- não se aplica; portão interno testado (caso 7)
RLS VALIDADA: [x] (tabela nova continua nascendo com RLS -- caso 3)
GRANTS VALIDADOS: [x] (proacl fotografado e conferido; EXECUTE intacto -- caso 2)
RPCS VALIDADAS: [x] (SECURITY DEFINER, search_path fixo e portão interno conferidos)
PII MASCARADA: [ ] não se aplica
ARQUIVOS PRIVADOS: [ ] não se aplica
ALTERAÇÕES OPERACIONAIS INESPERADAS: 0
ROLLBACK PREPARADO: [x] (remoção determinística pela mesma âncora, testada no CI)
GATE AUTOMÁTICO: [x] no fixture do CI (0 BLOQUEIA) · [ ] contra PRODUÇÃO: NÃO COMPROVADO
RESULTADO: [x] ☑ APROVADO PARA APLICAÇÃO -- condicionado a: (1) autorização
           explícita da gestão, (2) executor único = sessão principal,
           (3) PITR desligado, rollback à mão
```

---

## 7. Ordem de aplicação, se as duas forem aprovadas

1. **Primeiro** o revoke das 545 existentes (`20261107200000`) — fecha o
   estoque, que é onde está o lastro.
2. **Depois** este patch (`20261108120000`) — impede o estoque de voltar a
   crescer com o grant aberto.

A ordem inversa também funciona; nenhuma depende da outra. Esta é a ordem que
protege primeiro o que já existe.

**Nota de merge:** as duas PRs acrescentam um job ao mesmo `ci.yml`, cada uma
sobre a `origin/main`. A que entrar depois vai precisar de rebase do `ci.yml` —
é um append, conflito trivial.
