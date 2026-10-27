# Fechar o oráculo interno do encerramento — proposta redesenhada

**Data:** 27/10/2026 · **Branch:** `fix/cpf-ambiguo-identidade-v2`
**Estado: PROPOSTA. Nada aplicado, nenhuma permissão alterada, nenhum corpo de função tocado.**
**Revisão 2.** A revisão 1 foi **rejeitada pela gestão**, com razão. Ver seção 0.

## 0. O que a revisão 1 propunha, e por que era perigosa

Eu propunha pôr **portão de gestão dentro de `caso_encerramento_congelado(uuid)`**,
oferecendo à gestão "escolher entre devolver `false` ou levantar `42501`".

**As duas variantes estavam erradas, e a primeira falhava calada.**

`caso_encerramento_congelado(uuid)` **não é fachada de leitura**: é predicado
**dentro** de duas funções que escrevem. Conferido em produção em 27/10/2026, com
o comentário da própria `20261026200000` no trecho:

```
…soltaria 8 casos / R$ 7.584,60 na primeira passagem.
and not public.caso_encerramento_congelado(c.id)
```

Está em `casos_elegiveis_liberacao_fidelizacao` e em `casos_reabrir_com_divida`.

O mecanismo que eu não considerei: **`security definer` troca o contexto de
privilégio, não o JWT da sessão.** `usuario_e_gestao()` dentro do predicado
continuaria respondendo pelo **chamador**. Logo:

- **variante `false`** → `not congelado` vira **true** para todo não-gestão → os
  **8 casos / R$ 7.584,60 voltam a ser soltos da carteira, sem erro nenhum**;
- **variante `42501`** → as duas funções **levantam exceção** para operador e
  para o reabridor.

Era dicotomia falsa. A gestão rejeitou e autorizou o redesenho: **predicado
interno preservado, acesso externo controlado.**

---

# 1. O redesenho: ACL em vez de lógica

O censo mudou o desenho, e para muito melhor.

## O censo, medido em produção em 27/10/2026 (autorizado, só leitura)

Chamadores das três auxiliares, cobrindo funções, **views**, **gatilhos** e
funções **com direitos do invocador**:

| Auxiliar | Quem chama | `security definer` | Dono |
|---|---|---|---|
| `_caso_encerrado_operacional_regra` | `caso_encerrado_operacional` (as **duas** assinaturas) | **sim** | postgres |
| `_caso_sem_saldo_conferido` | `_caso_encerrado_operacional_regra` | **sim** | postgres |
| `_encerramento_congelado` | `_caso_encerrado_operacional_regra` | **sim** | postgres |

**Zero views. Zero gatilhos. Zero chamadores com direitos do invocador.**

E `caso_encerramento_congelado(uuid)`: chamada **só** por
`casos_elegiveis_liberacao_fidelizacao` e `casos_reabrir_com_divida`, ambas
`security definer` do `postgres`.

**No app: zero consumidores** para as quatro — nenhuma chamada em `src/` nem em
funções de borda.

## A consequência: nenhuma mudança de corpo é necessária

Como **todos** os consumidores são `security definer` do dono, eles **não
dependem** do grant a `authenticated`. Então o conserto é só privilégio:

```sql
revoke execute on function public._caso_sem_saldo_conferido(uuid, text)                                 from authenticated;
revoke execute on function public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text) from authenticated;
revoke execute on function public._encerramento_congelado(uuid,uuid,text,text,text,text,text)           from authenticated;
revoke execute on function public.caso_encerramento_congelado(uuid)                                     from authenticated;
```

**O predicado interno fica byte-idêntico.** Nenhum corpo muda, nenhum caso
congelado é liberado, nenhuma cobrança reabre, nada de saldo, acordo ou vínculo é
tocado — e isso não é promessa, é consequência de não mexer em lógica.

**A fachada com portão não precisa existir hoje**, porque não há consumidor
externo. Se um dia uma tela precisar mostrar "congelado" à gestão, aí se cria uma
função nova, com portão como **primeira instrução executável**, no padrão de
`caso_encerramento_pendentes` — e **sem** tocar o predicado. Fica registrado como
desenho aprovado, não como trabalho pendente.

## Uma dependência de ORDEM, descoberta pelo teste

**Revogar `authenticated` não fecha nada enquanto PUBLIC tiver EXECUTE.**
`authenticated` alcança as auxiliares **por PUBLIC**, não por concessão própria —
medido em bancada, teste `R4`.

Portanto:

- **em produção** o passo já está habilitado, porque o `revoke` de PUBLIC
  aconteceu em 27/10 15:25 UTC;
- **em ambiente novo** este `revoke` de `authenticated` é **inócuo** se vier antes
  da migration `20261027160000`.

A migration deste passo tem de ser **posterior** a `20261027160000`. Versão
proposta: `20261027170000_revoke_authenticated_auxiliares_encerramento.sql`.

## O que CONTINUA aberto, e é decisão consciente

As **duas** assinaturas públicas de `caso_encerrado_operacional` mantêm
`authenticated`, porque a operação inteira depende delas — 39 funções, 1 view, o
gatilho de `casos` e duas funções de carteira. Elas recebem **CPF por parâmetro**
e não têm portão.

**Consequência:** depois deste passo, operador autenticado ainda pode sondar CPF
pelas duas públicas. O oráculo interno fica **reduzido**, não fechado.

Fechá-lo é **mudança de contrato** — resolver a identidade por
`auth.email()`/`auth.uid()` em vez de receber CPF —, com 39 chamadores a migrar, o
que o Fluxo B do `DUAS-TRILHAS` obriga. **Recomendo backlog**, não agora, e
recomendo que a decisão seja explícita: é ela que fecha a violação da §4 da
premissa de segurança.

---

# 2. Os testes

Em `supabase/tests/revoke_execute_public_encerramento.test.js`. Rodados em
27/10/2026, com as duas migrations em disco: **20 de 20 verdes**, nenhum
suspenso. O sentinela `T2` deixou de ser vermelho — ele exige existência **e** o
md5 aprovado das duas — e os testes que dependiam das migrations passaram a
rodar.

## A trava dos 8 casos / R$ 7.584,60

**Limite declarado:** `public.casos` está vazia na bancada e nenhum caso é
elegível à liberação de fidelização, então a exclusão **ponta a ponta não é
exercitada**. O que o teste tranca são as peças de que ela depende:

| Teste | O que prova | Estado |
|---|---|---|
| `R1` | o predicado responde `false` antes e `true` depois de congelar | **verde** |
| `R2` | a mudança de ACL **não altera** a resposta do predicado | **verde** |
| `R3` | a cláusula `and not … congelado` continua nos **dois** consumidores | **verde** |
| `R4` | revogar só `authenticated` é **inócuo** enquanto PUBLIC tiver EXECUTE | **verde** |
| `R5` | na ordem certa, as auxiliares fecham e a pública de 5 args é preservada | **verde** |

**R1 e R2 pegam exatamente o defeito que a revisão 1 quase introduziu:** um
portão dentro do predicado faria `R2` ficar vermelho, porque a resposta passaria a
depender do chamador. O teste tranca a **propriedade**, não o mecanismo.

Nenhum dado real: um caso mínimo criado na bancada, valores inventados.

**Correção de uma anotação minha:** eu registrei que a trilha de congelamento não
tem FK em `caso_id`. **Tem** — conferido ao escrever o teste. Minha nota valia
para a tabela de auditoria de `20261026195000`, que é outra. Confundi as duas.

---

# 3. Decisões necessárias

1. **Autorizar o passo de ACL** (as quatro revogações de `authenticated`), como
   migration posterior a `20261027160000`. O censo está feito, o risco de quebrar
   chamador está medido como zero, e nenhum corpo de função muda.
2. **Ratificar que a fachada com portão não entra agora** — não há consumidor.
3. **Decidir o contrato das duas públicas:** backlog ou fora de pauta. É a única
   peça que fecha a §4, e é a mais cara.

## Bloqueio real

`P3/migration` impede escrever
`20261027170000_revoke_authenticated_auxiliares_encerramento.sql`, pelo mesmo
motivo da outra: o canal da Fase 2 não chega a esta sessão. O SQL está acima, no
caminho que o hook autoriza.

---

# 4. O artefato aprovado — `20261027170000`, na íntegra

**Registrado em 27/10/2026 a pedido do Guardião, e atualizado depois dos
dois ajustes que a gestão autorizou.** O selo de md5 do teste `T2` só é selo
quando o valor aprovado vive **fora** do arquivo que ele sela: do contrário,
quem edita o SQL edita o md5 ao lado, e a verificação detecta deriva
acidental mas **não** alteração deliberada. **Esta seção é a âncora.**

| | |
|---|---|
| md5 aprovado | `23b02327dd011af45bc6429eed67a35e` |
| md5 anterior, superado | `91d5c87666fa2e96af4f34a0ad85a810` |
| Bytes | 10451 |
| Linhas | 192 |

## Os dois ajustes, e o que eles consertaram

**1. A guarda de ordem passou a olhar as SEIS assinaturas e também `anon`.**
Antes olhava só PUBLIC e só as quatro auxiliares, o que deixava um caminho
**útil-porém-incompleto**: num estado parcialmente aplicado — possível na
aplicação statement a statement, fora de `apply_migration`/`db push` — ela
fechava as quatro e terminava **verde** com o caminho anônimo ainda aberto
pelos wrappers `caso_encerrado_operacional`, que são `security definer` e
alcançam as auxiliares com os direitos do dono. O erro foi renomeado para
`CAMINHO_ANONIMO_ABERTO`.

Validado em PGlite em 27/10/2026, e **cada cenário tem teste**, não só
medição à mão — o Guardião apontou que o último não tinha, e agora tem:

| Cenário | Teste |
|---|---|
| ordem errada aborta | `T5b` |
| **o estado parcial aborta** (a guarda antiga passaria verde) | `T5e` |
| ordem certa: PUBLIC 0/6, `anon` 0/6, `service_role` 6/6, `authenticated` 0/4 nas auxiliares e 2/2 nos wrappers | `T5c` |
| reaplicar as duas não quebra | `T5d` |
| o rollback da `170000` devolve `authenticated` 4/4 **mantendo** PUBLIC 0/6 | `RB1` |
| o rollback da `170000` **recusa** se o P0 tiver sido reaberto | `RB2` |
| o rollback da `160000` restaura PUBLIC em **cinco** e deixa a sexta fechada | `RB3` |

Os três últimos são novos: antes "rollback preparado" valia como arquivo
existente, não como **efeito comprovado**.

**2. O cabeçalho deixou de afirmar o que a migration não faz.** A primeira
linha dizia "FECHA O ORACULO INTERNO", e o próprio cabeçalho a contradizia
quarenta linhas abaixo. Agora diz que fecha o **acesso direto às quatro
auxiliares** e **não elimina** a consulta de CPF pelos dois wrappers
autenticados, apontando a pendência da §3.

Preservados integralmente: os corpos das funções, os quatro `revoke`
aprovados, a ordem das migrations e as conferências finais.

## O SQL

Gerado **a partir do arquivo em disco**, não redigitado.

```sql
-- =============================================================================
-- RESTRINGE EXECUTE DE `authenticated` NAS QUATRO FUNCOES AUXILIARES
--
-- FECHA O ACESSO DIRETO AS QUATRO AUXILIARES. NAO ELIMINA a consulta de CPF.
--
-- Depois de 20261027160000 ter fechado o acesso ANONIMO, qualquer usuario
-- AUTENTICADO -- inclusive operador sem perfil de gestao -- ainda podia chamar
-- estas quatro com CPF ou uuid arbitrario e descobrir se aquele CPF estava sem
-- divida. Esta migration fecha ESSE caminho.
--
-- O QUE ELA NAO FECHA, e e preciso ler isto antes de concluir que o problema
-- acabou: os DOIS WRAPPERS publicos `caso_encerrado_operacional` -- o de 5 e o
-- de 7 argumentos -- MANTEM EXECUTE para `authenticated`, porque a operacao
-- inteira depende deles (39 funcoes, 1 view, o gatilho de `casos` e duas
-- funcoes de carteira). Eles sao `security definer`, recebem CPF por parametro
-- e NAO tem portao interno. Logo qualquer autenticado SEGUE podendo sondar CPF
-- por eles. Fechar isso e mudanca de CONTRATO, com 39 chamadores a migrar, e
-- esta registrada como pendencia na §3 de
-- docs/P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md.
--
-- ORDEM OBRIGATORIA: 20261027160000 PRIMEIRO.
-- `authenticated` alcanca as auxiliares POR PUBLIC, nao por concessao propria.
-- Medido em bancada (teste R4 de supabase/tests/revoke_execute_public_encerramento.test.js):
-- revogar `authenticated` enquanto PUBLIC tiver EXECUTE e INOCUO. Em producao o
-- pre-requisito ja existe, porque PUBLIC foi revogado em 27/10/2026 15:25 UTC;
-- em ambiente novo, NAO existe antes de 20261027160000 rodar.
--
-- CORPO DE FUNCAO: NENHUM e tocado. Zero `create or replace`, zero DML, zero
-- mudanca de privilegio padrao. O predicado de congelamento fica byte-identico,
-- logo nenhum caso congelado e liberado, nenhuma cobranca reabre, e nada de
-- saldo, acordo ou vinculo muda. Nao aciona a §10 da premissa de seguranca.
--
-- O PORTAO INTERNO FOI REPROVADO PELA GESTAO, e com razao: por um tempo esta
-- frente propos por portao de gestao DENTRO de `caso_encerramento_congelado`.
-- Ela e PREDICADO dentro de `casos_elegiveis_liberacao_fidelizacao` e de
-- `casos_reabrir_com_divida`, e `security definer` troca o contexto de
-- PRIVILEGIO, nao o JWT -- entao `usuario_e_gestao()` responderia pelo CHAMADOR.
-- A variante "devolve false" soltaria 8 casos / R$ 7.584,60 da carteira EM
-- SILENCIO; a variante 42501 derrubaria o reabridor. Nada disso esta aqui.
--
-- CENSO DOS CHAMADORES, medido em producao em 27/10/2026 (so leitura):
--   _caso_encerrado_operacional_regra  <- caso_encerrado_operacional (as duas assinaturas)
--   _caso_sem_saldo_conferido          <- _caso_encerrado_operacional_regra
--   _encerramento_congelado            <- _caso_encerrado_operacional_regra
--   caso_encerramento_congelado        <- casos_elegiveis_liberacao_fidelizacao
--                                         casos_reabrir_com_divida
-- TODOS `security definer` com owner `postgres`. ZERO views, ZERO gatilhos,
-- ZERO chamadores com direitos do invocador. No app: ZERO chamadas.
-- Logo nenhum consumidor legitimo depende do grant a `authenticated`.
--
-- O QUE CONTINUA ABERTO, por decisao consciente: as DUAS assinaturas publicas
-- de `caso_encerrado_operacional` mantem `authenticated`, porque a operacao
-- inteira depende delas -- 39 funcoes, 1 view, o gatilho de `casos` e duas
-- funcoes de carteira. Elas recebem CPF por parametro e nao tem portao, entao
-- operador autenticado ainda pode sondar CPF por elas. Fechar isso e mudanca de
-- CONTRATO, com 39 chamadores a migrar, e esta registrada como pendencia na §3
-- de docs/P1-PORTAO-INTERNO-ENCERRAMENTO-PROPOSTA.md.
--
-- ROLLBACK: supabase/rollbacks/20261027170000_revoke_authenticated_auxiliares_encerramento.rollback.sql
--
-- DUAS DEPENDENCIAS DECLARADAS, porque `revoke` NAO e idempotente:
--   1. O papel `authenticated` precisa EXISTIR, senao 42704. Em PGlite ele vem
--      de supabase/tests/fixtures/grupo_a_prod_20260918.sql.
--   2. O executor precisa ser o DONO ou ter grant option. Um `revoke` feito por
--      papel sem direito emite WARNING "no privileges could be revoked" e NAO
--      revoga nada -- falha silenciosa. O bloco de conferencia do fim pega isso.
--
-- ATOMICIDADE: sem `begin`/`commit`, como a maioria do repositorio. A guarda e
-- a conferencia so valem se o caminho de aplicacao envolver o arquivo numa
-- transacao -- `apply_migration` e `db push` o fazem.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- GUARDA: as quatro precisam existir, E PUBLIC precisa JA estar fechado.
--
-- A segunda metade e o que impede esta migration de parecer que fez algo quando
-- nao fez: sem 20261027160000, `authenticated` continua alcancando por PUBLIC.
-- -----------------------------------------------------------------------------

do $guarda$
declare
  v_faltam  text;
  v_publico text;
begin
  select string_agg(a.sig, ', ' order by a.sig) into v_faltam
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where to_regprocedure(a.sig) is null;

  if v_faltam is not null then
    raise exception
      'FUNCOES_AUSENTES: %. Aplique 20261026200000 antes desta migration.',
      v_faltam;
  end if;

  -- Olha as SEIS, e tanto PUBLIC quanto `anon`.
  --
  -- Antes olhava so PUBLIC e so as quatro auxiliares. Isso deixava um caminho
  -- UTIL-POREM-INCOMPLETO: num estado parcialmente aplicado -- possivel na
  -- aplicacao statement a statement, fora de `apply_migration`/`db push` --
  -- esta migration fechava as quatro e terminava VERDE com o caminho anonimo
  -- ainda aberto pelos wrappers `caso_encerrado_operacional`, que sao
  -- `security definer` e alcancam as auxiliares com os direitos do dono.
  -- Tambem nao olhava `anon`: uma concessao DIRETA a `anon` passava verde.
  select string_agg(a.sig, ', ' order by a.sig) into v_publico
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerrado_operacional(text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where has_function_privilege('public', to_regprocedure(a.sig), 'EXECUTE')
      or has_function_privilege('anon',   to_regprocedure(a.sig), 'EXECUTE');

  if v_publico is not null then
    raise exception
      'CAMINHO_ANONIMO_ABERTO: PUBLIC ou anon ainda executam %. Aplique 20261027160000 PRIMEIRO e confira que ela fechou as SEIS -- revogar `authenticated` enquanto existir caminho anonimo e inocuo, e terminar verde aqui esconderia a exposicao.',
      v_publico;
  end if;
end
$guarda$;

-- -----------------------------------------------------------------------------
-- A RESTRICAO
-- -----------------------------------------------------------------------------

revoke execute on function public._caso_sem_saldo_conferido(uuid, text)                                 from authenticated;
revoke execute on function public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text) from authenticated;
revoke execute on function public._encerramento_congelado(uuid,uuid,text,text,text,text,text)           from authenticated;
revoke execute on function public.caso_encerramento_congelado(uuid)                                     from authenticated;

-- -----------------------------------------------------------------------------
-- CONFERENCIA, NOS DOIS SENTIDOS
--
-- Por PRIVILEGIO EFETIVO (`has_function_privilege`), nunca por `aclexplode`
-- sobre `proacl`: `proacl` NULO e o estado PADRAO, que para funcao INCLUI
-- EXECUTE a PUBLIC, e `aclexplode` de um nulo devolve zero linhas.
-- -----------------------------------------------------------------------------

do $confere$
declare
  v_aberto  text;
  v_quebrou text;
begin
  -- (1) `authenticated` e PUBLIC NAO podem executar as quatro auxiliares
  select string_agg(a.sig, ', ' order by a.sig) into v_aberto
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where has_function_privilege('authenticated', to_regprocedure(a.sig), 'EXECUTE')
      or has_function_privilege('public',        to_regprocedure(a.sig), 'EXECUTE');

  if v_aberto is not null then
    raise exception
      'ACESSO_AINDA_ABERTO: authenticated ou PUBLIC seguem com EXECUTE em %. Verifique se o executor e dono ou tem grant option -- revoke sem direito emite WARNING e nao revoga.',
      v_aberto;
  end if;

  -- (2) `service_role` PRECISA manter, e as DUAS publicas tambem
  select string_agg(a.sig, ', ' order by a.sig) into v_quebrou
    from (values
      ('public._caso_sem_saldo_conferido(uuid,text)'),
      ('public._caso_encerrado_operacional_regra(uuid,uuid,text,text,text,text,text)'),
      ('public._encerramento_congelado(uuid,uuid,text,text,text,text,text)'),
      ('public.caso_encerramento_congelado(uuid)')
    ) as a(sig)
   where not has_function_privilege('service_role', to_regprocedure(a.sig), 'EXECUTE');

  if v_quebrou is not null then
    raise exception
      'SERVICE_ROLE_PERDIDO: service_role perdeu EXECUTE em %. A restricao foi alem do escopo.',
      v_quebrou;
  end if;

  if not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(text,text,text,text,text)'), 'EXECUTE')
     or not has_function_privilege('authenticated',
         to_regprocedure('public.caso_encerrado_operacional(uuid,uuid,text,text,text,text,text)'), 'EXECUTE') then
    raise exception
      'OPERACAO_QUEBRADA: authenticated perdeu EXECUTE numa das assinaturas PUBLICAS de caso_encerrado_operacional. A operacao inteira depende delas -- esta migration nao deveria toca-las.';
  end if;
end
$confere$;
```

Para reconferir, calcule o md5 do arquivo `20261027170000_revoke_authenticated_auxiliares_encerramento.sql` na pasta versionada
de SQL do Supabase: deve devolver `23b02327dd011af45bc6429eed67a35e`.
