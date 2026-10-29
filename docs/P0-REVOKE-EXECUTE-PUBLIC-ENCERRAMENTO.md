# P0 — Revogar EXECUTE de PUBLIC/anon nas quatro funções do encerramento

**Data:** 27/10/2026 · **Branch:** `fix/cpf-ambiguo-identidade-v2`
**Estado:** **PREPARADO, NÃO EXECUTADO.** Nenhum `revoke` rodou em produção.
**Guardião:** **REPROVADO para aplicação imediata** em 27/10/2026. Correções
aplicadas abaixo; o que falta está na seção 8.
**Severidade: COMPROVADA em 27/10/2026 por sonda HTTP.** Não é mais suposição.
Duas chamadas anônimas, com a chave publicável e CPF fictício, responderam
**HTTP 200**:

| Sonda anônima, de leitura (as CINCO) | Resultado |
|---|---|
| `POST /rpc/_caso_sem_saldo_conferido` | **200**, corpo `false` |
| `POST /rpc/_caso_encerrado_operacional_regra` | **200**, corpo `false` |
| `POST /rpc/_encerramento_congelado` | **200**, corpo `false` |
| `POST /rpc/caso_encerrado_operacional` (7 args) | **200**, corpo `false` |
| `GET /rpc/caso_encerramento_congelado?p_caso_id=0000…0000` | **200**, corpo `false` |

Todas com `p_aluno_id`/`p_caso_id` nulos e CPF `00000000000`. **Cinco de cinco
medidas** — nenhuma inferida.

E a primeira tentativa, por GET com uuid vazio, devolveu **400 com SQLSTATE
`22P02`** — erro do Postgres *de dentro* da chamada, não 404 nem 401: prova de
que a função foi roteada e invocada.

Conclusões firmes: **o prefixo `_` não protege nada** (o PostgREST não filtra por
sublinhado), e `anon` alcança estas funções pela API pública. O CPF `00000000000`
faz `_cpf11` devolver nulo, então a sonda responde `false` **sem consultar
`alunos`** — verificado antes de rodar. Nenhum dado de aluno real foi acessado.
**Alvo:** prod `ahattpqrjmhkzsmnbdzs`

## 1. As quatro assinaturas exatas e os privilégios atuais

Medido em produção em 27/10/2026. As quatro têm ACL idêntica, owner `postgres`,
`security definer`, `search_path=public` e volatilidade `stable`.

```
_caso_sem_saldo_conferido(uuid,text)
_caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)
_encerramento_congelado(uuid,uuid,text,text,text,text,text)
caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)
```

ACL atual, nas quatro:

```
{=X/postgres,postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
```

O `=X` inicial, sem papel à esquerda, é **PUBLIC com EXECUTE**. Daí
`has_function_privilege('anon', …, 'execute')` = `true` nas quatro.

**`anon` não tem concessão direta.** Não existe `anon=X` na ACL: o acesso dele
vem **só** por PUBLIC. Revogar de PUBLIC já o remove; revogar de `anon` também é
redundante, porém explícito, e foi mantido por ser o que a gestão pediu.

A assinatura de **5 argumentos** de `caso_encerrado_operacional` **não** tem
PUBLIC e **não** entra nesta correção.

### A causa raiz, e uma correção do que eu havia escrito

**A causa raiz é NÃO COMPROVADA, e eu já errei duas explicações.** Registro as
duas retratações e o que de fato está medido.

*Primeira tentativa, errada:* "a trava era pretendida e saiu inconsistente".
Sem proveniência.

*Segunda tentativa, também errada:* "houve omissão sistemática — função nova
nasce com PUBLIC e o que separa as fechadas das abertas é a idade". Duas
medições a derrubam:

1. **325 de 508** arquivos de migration que criam função **já revogam**
   `from public, anon`. A convenção existe e é majoritária; `20261026200000` é
   **desvio**, não norma. (Ela concede EXECUTE **10** vezes — não sete, como eu
   escrevi — e não revoga nenhuma.)
2. **Neste banco, função nova criada por `postgres` em `public` NÃO nasce com
   PUBLIC.** Medido em `pg_default_acl`:

   | Schema `public`, papel criador | ACL padrão das funções novas |
   |---|---|
   | `postgres` | `{postgres=X, authenticated=X, service_role=X}` — sem PUBLIC, sem `anon` |
   | `supabase_admin` | `{postgres=X, **anon=X**, authenticated=X, service_role=X}` |

   Confirmação independente: `casos_elegiveis_liberacao_fidelizacao()`, criada
   pela mesma migration **sem `grant` algum**, tem ACL
   `{postgres=X,authenticated=X,service_role=X}` e `anon` **não** a executa.

Logo as cinco expostas são **anomalia**, não consequência do padrão, e o `=X`
delas não se explica nem pelo repositório nem pelo privilégio padrão vigente.
**A proveniência não é recuperável** com o que existe — agravada pela ausência de
entrada no ledger para `20261026200000`. Fica como NÃO COMPROVADO, e isso é o
mais honesto que consigo dizer.

## 2. Dependências verificadas — nenhuma quebra

### Chamadores internos

| Alvo | Funções | Views | Triggers | Chamadores **sem** `security definer` |
|---|---|---|---|---|
| `_caso_sem_saldo_conferido` | 1 | 0 | 0 | 0 |
| `_caso_encerrado_operacional_regra` | 2 | 0 | 0 | 0 |
| `_encerramento_congelado` | 3 | 0 | 0 | 0 |
| `caso_encerrado_operacional` (as duas) | 41 | 1 | 0 | 3 |

Só os chamadores **sem** `security definer` importam: eles rodam com o
privilégio de quem chama, então dependem do grant. Os três existentes, e a view,
foram abertos e conferidos um a um:

| Chamador | `security definer` | Assinatura que usa |
|---|---|---|
| `casos_set_encerrado_operacional()` (função de **trigger**) | não | **5 args** |
| `preview_redistribuicao_casos()` | não | **5 args** |
| `resumo_carteira_operador(text)` | não | **5 args** |
| `vw_saude_carteira` (view) | — | **5 args** |

**Os quatro usam a assinatura de 5 argumentos, que não está na correção.**
Portanto **nenhum chamador sem `security definer` toca as quatro revogadas**.
Todos os demais chamadores são `security definer` com owner `postgres`, e por
definição não dependem de grant a PUBLIC.

Duas conferências extras no caminho do trigger, por ser o único que roda em
escrita de usuário:

- `anon` **não** tem `insert` nem `update` em `public.casos` → o trigger não é
  alcançável por `anon` de nenhum jeito.
- `authenticated` tem `update` em `casos` → o trigger roda como `authenticated`,
  que **mantém** EXECUTE em tudo depois desta correção.
- `vw_saude_carteira`: nem `anon` nem `authenticated` têm `select` nela.

### Chamadores externos

Busca no código do app (`src/`, `supabase/functions/`) pelos quatro nomes:
**nenhuma chamada**. Os dois únicos acertos para `caso_encerrado_operacional`
são um **comentário** (`src/utils/carteiraFila.js:122`) e dois **rótulos de
relatório** (`src/utils/exportarSaudeCarteira.js:223,240`). Não há
`.rpc('<qualquer uma das quatro>')` em lugar nenhum.

## 3. A correção mínima (NÃO EXECUTADA)

Para função, o único privilégio é EXECUTE, então `revoke execute` é o mínimo
exato — `revoke all` seria mais amplo em intenção que em efeito. Nada é
concedido; só revogado.

**Escopo fechado em CINCO assinaturas** (a quinta entrou pelo contorno de RLS
documentado adiante):

```sql
begin;

revoke execute on function public._caso_sem_saldo_conferido(uuid, text)
  from public, anon;
revoke execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerramento_congelado(uuid)
  from public, anon;

commit;
```

Revogar de `anon` além de PUBLIC é **no-op** — `anon` não tem concessão direta, e
a ACL do PostgreSQL não guarda entrada negativa, então revogar de quem não tem
não cria nada nem atrapalha concessão futura. Mantido por ser explícito.
`revoke all` seria idêntico em efeito, já que EXECUTE é o único privilégio de
função.

`authenticated` e `service_role` permanecem, por concessão própria na ACL — não
por PUBLIC. A de 5 argumentos não é tocada.

## 4. Rollback controlado (NÃO EXECUTADO)

Devolve exatamente o estado de 27/10/2026 — que é o estado **vulnerável**. Só se
justifica se a revogação quebrar algum chamador não previsto.

```sql
begin;

grant execute on function public._caso_sem_saldo_conferido(uuid, text) to public;
grant execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text) to public;
grant execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text) to public;
grant execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text) to public;
grant execute on function public.caso_encerramento_congelado(uuid) to public;

commit;
```

Não há `grant … to anon`, porque `anon` nunca teve concessão direta: devolver a
PUBLIC restaura o estado original tal como estava.

## 5. Testes de acesso (PREPARADOS, NÃO EXECUTADOS)

Não rodei: executá-los exige revogar, mesmo em transação revertida, e a
autorização vigente é explícita em não executar `revoke` em produção.

### Linha de base, já medida HOJE (antes)

| Papel | `anon` | `authenticated` | `service_role` |
|---|---|---|---|
| nas quatro | **true** | true | true |

### Esperado depois

| Papel | `anon` | `authenticated` | `service_role` |
|---|---|---|---|
| nas quatro | **false** | true | true |

```sql
select p.oid::regprocedure::text as assinatura,
       has_function_privilege('anon', p.oid, 'execute')          as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute')  as service_role,
       p.proacl::text as acl
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.oid::regprocedure::text in (
     '_caso_sem_saldo_conferido(uuid,text)',
     '_caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)',
     '_encerramento_congelado(uuid,uuid,text,text,text,text,text)',
     'caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)')
 order by 1;
```

Critério: `anon` = `false`; `authenticated` e `service_role` = `true`; e
**nenhuma concessão a PUBLIC**. Qualquer outra combinação → rollback.

**Não comparar `proacl` como texto.** A ACL é um array e o texto dela não é
estável: depois de um `grant` o PUBLIC vai para o FIM do array, não para o
início, e a entrada grava **quem concedeu** — aplicado por `supabase_admin` em
vez de `postgres`, vira `=X/supabase_admin`. Comparar string daria falso
negativo num rollback legítimo. Comparar como conjunto:

```sql
select p.oid::regprocedure::text as assinatura,
       coalesce(a.grantee::regrole::text, 'PUBLIC') as papel,
       a.privilege_type
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join lateral aclexplode(p.proacl) a on true
 where n.nspname = 'public'
   and p.proname in ('_caso_sem_saldo_conferido','_caso_encerrado_operacional_regra',
                     '_encerramento_congelado','caso_encerrado_operacional',
                     'caso_encerramento_congelado')
 order by 1, 2;
```

`a.grantee = 0` é PUBLIC. Depois da correção, nenhuma linha das revogadas pode
sair com `papel = 'PUBLIC'`.

### Prova funcional, como `anon`

Antes, responde um booleano. Depois, tem de dar **42501**.

```sql
begin;
set local role anon;
select public._caso_sem_saldo_conferido(null, '00000000191');  -- esperado: 42501
rollback;
```

Dois reparos neste teste, que sem eles pode "passar" pelo motivo errado:

1. Se o papel da sessão **não for membro de `anon`**, o próprio `set local role`
   falha — e o teste aborta parecendo sucesso. Distinguir o erro do `SET ROLE`
   do erro da chamada.
2. **42501 também apareceria** se faltasse `USAGE` no schema `public`. Asseverar
   a **mensagem**, não só o código: tem de citar a função, não o schema.

E uma honestidade sobre o que este teste prova: `_caso_sem_saldo_conferido(null,
'00000000191')` devolve `false` tanto para "CPF sem correspondência" quanto para
"sem dívida". Ele prova **chamabilidade**, não o oráculo. O oráculo é real — a
função resolve o CPF em `alunos` e consulta o saldo —, mas quem o demonstra é a
leitura do corpo, não esta chamada.

### Não-regressão, como `authenticated`

```sql
begin;
set local role authenticated;
select public.caso_encerrado_operacional(
  null::uuid, null::uuid, '00000000191', null, null, null, null);  -- deve responder
rollback;
```

### Caminho do trigger, que é o único de escrita

```sql
select has_function_privilege('authenticated',
         'public.caso_encerrado_operacional(text,text,text,text,text)', 'execute') as auth_na_de_5;
-- deve seguir true: a de 5 argumentos nao e tocada
```

## 6. Mecanismos sensíveis seguem protegidos — conferido

| Função | Escreve | Portão interno | `anon` |
|---|---|---|---|
| `caso_encerramento_resolver(uuid,text,text)` | sim | **sim**, levanta exceção | alcança e **é recusado** |
| `caso_encerramento_resolver_aluno(uuid,text,text)` | sim | **sim**, levanta exceção | alcança e **é recusado** |
| `caso_encerramento_pendentes(integer)` | lista | **sim**, levanta exceção | alcança e **é recusado** |

A liberação de congelamento — a ação sensível — **nunca esteve aberta**: está
protegida por portão interno, que é o padrão do projeto. Esta correção não a
altera, e também não altera a trilha `caso_encerramento_sem_saldo`, nenhuma
tabela, policy, RLS, bucket ou cron.

Estas três **permanecem** com PUBLIC na ACL depois desta correção. Fica
registrado como pendência de endurecimento (defesa em profundidade: portão
interno é a trava, o grant amplo é a porta aberta na frente dela). Não entrou
aqui porque a gestão delimitou a correção às quatro.

### Uma QUINTA função, e um contorno de RLS medido

`public.caso_encerramento_congelado(uuid)` merece entrar no escopo. Medido em
produção em 27/10/2026:

- a tabela `caso_encerramento_sem_saldo` tem **RLS ligada** e **uma** policy:
  `caso_encerramento_sem_saldo_leitura_gestao [SELECT] -> coalesce(usuario_e_gestao(), false)`;
- a função é **`security definer`**, e o corpo inteiro é
  `select exists (select 1 from public.caso_encerramento_sem_saldo e where e.resolvido_em is null and e.caso_id = p_caso_id)`,
  **sem portão interno**;
- `anon` executa (`has_function_privilege` = true); `anon` **não** tem SELECT na
  tabela, e `authenticated` tem o privilégio de tabela mas a policy o restringe
  a gestão.

Logo a função **contorna a policy**: entrega a qualquer `authenticated` sem
perfil de gestão — e a `anon` — exatamente o dado que a policy existe para
restringir.

**Correção de um julgamento meu:** eu havia classificado esta função como risco
menor "porque UUID não é enumerável na prática". Isso é verdade para quem está
fora, e **falso para quem está dentro**: operador conhece os UUIDs dos casos da
própria carteira. O contorno é prático, não teórico. Recomendo incluí-la como
quinta linha do mesmo `revoke`:

```sql
revoke execute on function public.caso_encerramento_congelado(uuid) from public, anon;
```

## 6b. Proteção contra repetição (NÃO EXECUTADA)

**Retratação:** a primeira versão desta seção propunha
`alter default privileges for role postgres in schema public revoke execute on
functions from public` como proteção principal. **A medição mostra que isso é
quase inócuo:** o padrão vigente para `postgres` em `public` já **não** concede
PUBLIC nem `anon`. Revogar o que já não é concedido não protege nada.

### O risco futuro real, que eu não tinha visto

O padrão do papel **`supabase_admin`** em `public` concede **`anon=X`
explicitamente**:

```
supabase_admin / f = {postgres=X, anon=X, authenticated=X, service_role=X}
```

Qualquer função criada em `public` por `supabase_admin` nasce **chamável por
`anon`** — e por concessão direta, não por PUBLIC, então um
`revoke … from public` **não a fecharia**. É um padrão administrado pela
plataforma, fora das migrations. A consequência prática: **toda migration tem de
revogar explicitamente de `public, anon`**, independentemente do papel que a
aplica, porque não se controla qual papel será.

### A proteção que funciona: catraca de CI

Passa a ser a camada principal, não acessória. Deve ser construída sobre o
molde que já existe no repositório — `scripts/ci/catraca-migrations.mjs` —, cuja
doutrina é "o legado é tolerado, nenhum PR novo pode piorá-lo": indexa o branch
base e julga só o que é novo.

Especificação corrigida, depois de a primeira ter sido reprovada como não
implementável:

- **Casar por NOME de função, nunca por assinatura textual.** Assinatura em SQL
  quebra linha — nesta própria migration, `_encerramento_congelado` e
  `_caso_encerrado_operacional_regra` têm os argumentos em duas linhas. Casar
  assinatura exigiria parser.
- **Declarar a limitação da sobrecarga.** Casar por nome não distingue
  `caso_encerrado_operacional` de 5 e de 7 argumentos — e este caso é
  exatamente uma sobrecarga. A catraca pega a omissão total, não a parcial.
- **Lista de isenção versionada**, com justificativa por entrada.
- **Linha de base obrigatória.** Aplicada a todo o histórico, a regra reprovaria
  **194** migrations existentes. Sem linha de base ela não entra.

É verificação de texto: pega a omissão, não garante a semântica. Vale como rede,
não como prova.

### No procedimento

`docs/RUNBOOK-MIGRATIONS.md` passa a exigir, na seção de aplicação, conferência
de ACL por `aclexplode` para toda função criada ou substituída, com o critério
"nenhuma linha com papel `PUBLIC` nem `anon`". Hoje o runbook cobre versão,
testes, Guardião, MD5 e rollback, e **não** cobre ACL — foi por essa fenda que
isto passou.

### Se ainda assim quiserem mexer no privilégio padrão

Fica registrado o que a primeira versão não declarava, para que a decisão seja
informada:

- privilégio padrão é por papel criador **e por schema**. `in schema public`
  não cobre `internal`, que tem **14 funções, 2 delas com PUBLIC**, nem funções
  criadas sem schema qualificado, que caem onde o `search_path` apontar;
- `on functions` abrange **procedures e agregados**, não só funções;
- há **3 extensões instaladas em `public`** neste banco. Um
  `revoke execute on functions from public` por padrão não altera as já
  existentes, mas afetaria funções de extensão criadas depois pelo mesmo papel.

Aplicar não quebra nada existente: privilégio padrão só vale para objetos
futuros.

## 7. Riscos remanescentes

1. **A exposição continua valendo até o `revoke` rodar.** O que existe hoje é
   diagnóstico e preparo; a vulnerabilidade está de pé em produção neste momento.
2. **Há três funções da MESMA CLASSE fora deste escopo.** Das 124 funções de
   `public` com PUBLIC EXECUTE, 38 são `security definer`, 22 dessas recebem
   parâmetro e **7** não têm portão interno. Quatro são as desta correção. As
   outras três, nomeadas:

   | Assinatura | Retorna | Parâmetro é enumerável? |
   |---|---|---|
   | `prime_portador_snapshot_estado(integer,integer)` | `jsonb` | **sim** — portadores são inteiros pequenos (166, 195) |
   | `acordo_saldo_residual(uuid)` | `jsonb` | não na prática (UUID) |
   | `caso_encerramento_congelado(uuid)` | `boolean` | não na prática (UUID) |

   A primeira preocupa pelo mesmo motivo das quatro: parâmetro trivialmente
   enumerável e retorno com conteúdo financeiro. **Não as incluí** porque a
   gestão delimitou a correção às quatro — fica para decisão de ampliar o
   escopo. As outras 117 não foram auditadas uma a uma.
3. **As três funções de encerramento com portão interno seguem com PUBLIC** —
   por decisão de escopo, não por avaliação de que seja seguro.
4. **Enumeração já ocorrida é indetectável.** Não há log de chamadas de função
   nesta base: se alguém sondou CPFs, não há como saber. Não afirmo que ocorreu;
   afirmo que não é verificável.
5. **Esta correção não é migration.** Se for aplicada direto, o repositório não
   registra a mudança de ACL, e a próxima recriação da função por
   `create or replace` **preserva** a ACL — mas uma recriação por `drop`/`create`
   devolveria PUBLIC. O certo é a correção virar migration versionada; hoje a
   escrita de migration está barrada pelo `P3/migration`.

---

# PACOTE FINAL DE EXECUÇÃO — aguardando autorização expressa

Montado em 27/10/2026. **Nada aqui foi executado.** Executor proposto: sessão
principal de segurança, exclusivamente.

## A. As cinco assinaturas e os REVOKE

```sql
begin;

revoke execute on function public._caso_sem_saldo_conferido(uuid, text)
  from public, anon;
revoke execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text)
  from public, anon;
revoke execute on function public.caso_encerramento_congelado(uuid)
  from public, anon;

commit;
```

A assinatura de **5 argumentos** de `caso_encerrado_operacional` **não** está
aqui, e isso é deliberado: é a que o gatilho de `casos`, as duas funções de
carteira e a view `vw_saude_carteira` usam.

## B. Fotografia atual das ACLs (`aclexplode`), 27/10/2026

**20 linhas, 4 por função, idênticas em todas as cinco:**

| Papel | Privilégio | Concedente |
|---|---|---|
| **PUBLIC** | EXECUTE | postgres |
| postgres | EXECUTE | postgres |
| authenticated | EXECUTE | postgres |
| service_role | EXECUTE | postgres |

**Não existe concessão direta a `anon` em nenhuma das cinco.** O acesso de `anon`
vem exclusivamente de PUBLIC — por isso revogar PUBLIC o remove, e o
`, anon` do comando é no-op explícito.

Consulta que produz esta fotografia (rodar antes e depois):

```sql
select p.oid::regprocedure::text as assinatura,
       coalesce(nullif(a.grantee::regrole::text,'-'), 'PUBLIC') as papel,
       a.privilege_type as privilegio,
       a.grantor::regrole::text as concedente
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  left join lateral aclexplode(p.proacl) a on true
 where n.nspname = 'public'
   and p.oid::regprocedure::text in (
     '_caso_sem_saldo_conferido(uuid,text)',
     '_caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)',
     '_encerramento_congelado(uuid,uuid,text,text,text,text,text)',
     'caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)',
     'caso_encerramento_congelado(uuid)')
 order by 1, 2;
```

## C. Rollback — restaura exclusivamente o que havia

```sql
begin;

grant execute on function public._caso_sem_saldo_conferido(uuid, text) to public;
grant execute on function public._caso_encerrado_operacional_regra(uuid, uuid, text, text, text, text, text) to public;
grant execute on function public._encerramento_congelado(uuid, uuid, text, text, text, text, text) to public;
grant execute on function public.caso_encerrado_operacional(uuid, uuid, text, text, text, text, text) to public;
grant execute on function public.caso_encerramento_congelado(uuid) to public;

commit;
```

**Só a PUBLIC, e nada a `anon`** — porque `anon` nunca teve concessão direta
(seção B). Conceder a `anon` criaria privilégio que não existia antes, o que
seria ampliar acesso, não restaurar.

Depois do rollback, a fotografia volta a ter as 4 linhas por função. **Comparar
por conjunto**, nunca por texto de `proacl`: num `grant`, PUBLIC vai para o FIM
do array e o concedente passa a ser quem executou — comparar string daria falso
negativo.

## D. Quem continua funcionando — conferido duas vezes

`authenticated` e `service_role` **mantêm** EXECUTE nas cinco, por concessão
própria na ACL (seção B), não por PUBLIC. A revogação não os toca.

Chamadores legítimos, auditados por mim e reauditados pelo Guardião:

| Chamador | `security definer` | Assinatura que usa | Afetado? |
|---|---|---|---|
| `casos_set_encerrado_operacional()` (trigger de `casos`) | não | **5 args** | **não** |
| `preview_redistribuicao_casos()` | não | **5 args** | **não** |
| `resumo_carteira_operador(text)` | não | **5 args** | **não** |
| `vw_saude_carteira` (view) | — | **5 args** | **não** |
| os outros ~41 chamadores | **sim** | 5 e 7 args | **não** — `security definer` do owner não depende de PUBLIC |

Três conferências extras no caminho do gatilho, o único que roda em escrita de
usuário: `anon` **não** tem insert/update em `casos`; `authenticated` tem, roda o
gatilho e mantém EXECUTE; e nem `anon` nem `authenticated` têm SELECT em
`vw_saude_carteira`.

Chamadores externos: **nenhum**. No app, só um comentário e dois rótulos de
relatório.

## E. Validação pós-aplicação

**E.1 — ACL:** rodar a consulta da seção B. Critério: **nenhuma linha com papel
`PUBLIC`** nas cinco; `authenticated` e `service_role` presentes nas cinco.
Qualquer desvio → rollback da seção C.

**E.2 — HTTP anônimo.** As cinco respondiam **200** antes. Depois têm de
responder **401 ou 403**. Mesmas chamadas da sonda, com a chave publicável e
`p_aluno_id`/`p_caso_id` nulos e CPF `00000000000` — que faz `_cpf11` devolver
nulo, então nenhuma consulta a `alunos` acontece.

**E.3 — Perfis autorizados, em transação revertida:**

```sql
begin;
set local role authenticated;
select public.caso_encerrado_operacional(null::uuid, null::uuid, '00000000000', null, null, null, null);
rollback;
```

Tem de responder, não levantar erro. Repetir para as cinco e para
`service_role`.

Dois reparos obrigatórios na leitura destes testes: se o papel da sessão **não
for membro** de `authenticated`, o próprio `set local role` falha e o teste
"passa" pelo motivo errado — distinguir o erro do `SET ROLE` do erro da chamada.
E `42501` também apareceria por falta de `USAGE` no schema — asseverar a
**mensagem**, não só o código.

**E.4 — A de 5 argumentos intacta:**

```sql
select has_function_privilege('authenticated',
  'public.caso_encerrado_operacional(text,text,text,text,text)', 'execute') as deve_ser_true;
```

**E.5 — Não-regressão funcional:** o gatilho de `casos` continua gravando.
Conferir por um `update` real já previsto na operação, não por um escrito só
para o teste.

## F. Auditoria e registro

**Auditoria da aplicação:** colar no ledger a fotografia literal da seção B
antes e depois, o resultado das cinco sondas HTTP antes e depois, quem executou,
quando, e o número de linhas afetadas por declaração.

**Plano de incorporação, na ordem:**

1. Aplicar a correção emergencial (seções A + E), com autorização expressa e
   executor único.
2. **Registrar no ledger imediatamente** — inclusive que a alteração entrou
   **fora** de migration, o que é a dívida que o passo 3 paga.
3. Transformar as seções A e C em **migration versionada** + arquivo de
   rollback, pelo canal da Fase 2 com autorização nominal.
4. **Aplicar a migration sem reexecutar o SQL:** registrar a versão como
   aplicada, ou escrever o corpo idempotente, para que ela não repita o que já
   foi feito. `revoke` é idempotente por natureza, mas o registro tem de dizer
   que a mudança ocorreu no passo 1, não no passo 4 — senão o ledger mente sobre
   quando o acesso foi fechado.
5. Catraca de CI, com a especificação da seção 6b.

**O que NÃO entra nesta correção, por decisão da gestão:** privilégio padrão do
banco e a catraca de CI. A primeira, a medição mostrou que não é onde está o
conserto.
