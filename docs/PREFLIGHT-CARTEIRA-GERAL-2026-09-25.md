# Preflight da Carteira Geral — PR #517, commit 7cb382c

**25/09/2026 · somente leitura · NADA aplicado, NADA mesclado, nenhum lote executado**

## Veredito

**O preflight bloqueou uma vez e o bloqueio foi corrigido.** As 15 âncoras sempre
conferiram; o problema era de privilégio: um dos 15 patches injetava uma chamada
`internal.` dentro da **única** função patchada que roda como quem chama, e
`authenticated` **não tem USAGE no schema `internal`**. Aplicar a migration 4
naquele estado derrubaria o heartbeat do receptivo para todos os operadores
ativos.

**Corrigido** com um invólucro `SECURITY DEFINER` em `public`, sem abrir o schema
`internal` para `authenticated` — §3.3 conta como, e há **9 testes novos que
rodam como `authenticated`**, não como dono do banco, porque foi exatamente isso
que deixou o furo passar. O commit `7cb382c` **não** é mais o commit a aplicar.

Tudo o mais do preflight segue valendo, inclusive as medições de tempo em
produção e a reconferência das 15 âncoras, refeita depois da correção.

---

## 1. O commit, o CI e a main

| Conferência | Resultado |
|---|---|
| HEAD do PR #517 | `7cb382ce2b1c52247a10d072f6c1175057cac287` = `7cb382c` ✔ |
| `mergeable_state` | `clean` |
| CI | verde — `testes, build e catracas` 8m00s, Vercel, Vercel Preview Comments |
| `origin/main` | avançou de `ae0095e` (base do PR) para `b043204` |
| O que mudou na main | `src/assets/historia/nossa-historia-correta.webp`, `src/pages/PortalOperacional.jsx` |
| Interseção com os 14 arquivos do PR | **zero** |

**Migrations de produção:** 12 versões entradas desde `20260924120000`, sendo 5
de hoje. Duas delas mexem em `titulo_reavaliar` e `titulos_por_status_acordo`:

- `20260925123852_acordo_cancelado_sem_pagamento_reabre_mensalidade`
- `20260925125350_reabre_mensalidades_acordo_cancelado_sem_pagamento`

**Nenhuma das 14 funções que o #517 patcheia foi tocada.** Cruzei o texto das 12
migrations contra os 14 nomes: só `titulo_reavaliar` e `titulos_por_status_acordo`
aparecem, e nenhum dos dois está na lista do #517. Sem sobreposição.

(Registro para a outra etapa: essas duas migrations parecem reverter a regra de
22/09 — *acordo cancelado não reabre mensalidade* — que é premissa do #521. Não
investiguei; fica anotado para quando o #521 voltar.)

**Versão fora de ordem — resolvido em 26/09, ver §Reconciliação.** Os arquivos
do PR nasceram como `2026092417125x`, abaixo da última versão aplicada em
produção. Enquanto foi assim, isso não quebrava nada (a catraca do CI só olha o
checkout e `supabase db push` não é o caminho daqui), mas deixava o repositório
e o `schema_migrations` discordando.

Quando as migrations foram efetivamente aplicadas, em 25/09 às 18h, o
`apply_migration` gerou versões novas no momento da aplicação. **Os arquivos
foram renomeados para essas versões**, sem tocar o conteúdo — a reconciliação
está documentada na seção própria, mais abaixo.

## 2. As 15 âncoras contra produção

Extraí as 15 âncoras do próprio arquivo da migration 4 por regex sobre
`perform internal.patch_funcao_ancorada('public','<fn>', '<ancora>', ..., N)` e
comparei a contagem de ocorrências de cada uma com o `pg_get_functiondef` atual.

**Resultado: 15 de 15 `OK`.** 14 âncoras com 1 ocorrência e
`nivelar_medias_progressivo` com 2 — exatamente o esperado por cada patch.

**Refeita depois da correção de §3.3**, contra a produção de 25/09/2026 (já com as
5 migrations aplicadas hoje): **de novo 15 de 15 `OK`**, com as mesmas contagens.
A correção não mexeu em nenhuma âncora — ela troca o *texto novo* do patch (e2),
não a âncora, que continua sendo `begin` com uma ocorrência.

**Nenhuma diferença, portanto nenhuma adaptação de SQL foi feita.**

Vale lembrar por que isso é robusto: o patch lê a definição viva e substitui um
fragmento. Se alguém mudar o corpo de uma dessas funções amanhã, o patch preserva
a mudança — e se a âncora sumir, ele falha alto em vez de escrever errado.

## 3. Ordem, dependências, permissões, gatilhos, cron e reversão

### 3.1 Ordem e dependências

Ordem obrigatória, pela dependência real:

| # | Migration | Cria | Depende de |
|---|---|---|---|
| 1 | `20260925180744_carteira_geral_destino` | `internal.carteira_geral_email()`, a linha em `usuarios`, a coluna `usuarios.recebe_novos_casos`, `internal.operador_pode_receber_caso()`, tabelas `carteira_geral_previas` e `carteira_geral_auditoria` + RLS + gatilho append-only | schema `internal`, `calibragem_e_gestao()` |
| 2 | `20260925181117_carteira_geral_painel_previa` | `carteira_geral_base`, `_painel`, `_listar`, `_previa` | **1** (`carteira_geral_email`, `carteira_geral_previas`) |
| 3 | `20260925181554_carteira_geral_mover` | `internal.carteira_geral_trocar_dono`, `carteira_geral_mover`, `_desfazer_lote`, `_definir_recebimento` | **1** e **2** (lê a prévia gravada) |
| 4 | `20260925181823_carteira_geral_blindar_automacoes` | `internal.patch_funcao_ancorada`, os 15 patches, `carteira_geral_vigia()` | **1** (`operador_pode_receber_caso`, `carteira_geral_email`) |


### 3.2 Pré-requisitos, medidos em produção hoje

| Item | Estado |
|---|---|
| schema `internal` | existe |
| role `reativa_responsavel_executor` | existe |
| `public.calibragem_e_gestao()` | existe — e é exatamente os 3 e-mails da gestão |
| `internal.nome_operador_ativo(text)` | existe |
| `internal.set_resp_aluno` / `set_resp_acordo` | existem, 7 argumentos, donas do executor |
| as 14 funções a patchar | todas existem, com os tipos que os `alter function` usam |
| `usuarios.recebe_novos_casos` | **não existe** (a migration cria) |
| `carteira_geral_previas` / `_auditoria` | **não existem** |
| `carteira.geral@reativa.local` em `usuarios` | **não existe** |

Duas funções (`sistema_assumir_atendimento`, `sistema_assumir_receptivo`) **já**
têm `search_path = public, internal` porque já chamam `internal.`. Para essas
duas o `alter function` da migration 4 é inócuo. Para as outras 6, muda. São
**8** `alter function` no total — `fila_receptivo_heartbeat` saiu da lista, ver
§3.3.

### 3.3 O bloqueador que existia, e como ficou

Das 14 funções patchadas, 13 são `SECURITY DEFINER` e rodam como `postgres`, que
tem `UC` no schema `internal`. **Uma não é:**

```
public.fila_receptivo_heartbeat(text, text, boolean)
  prosecdef = false      -> roda como QUEM CHAMA
  acl: authenticated=X, service_role=X   -> quem chama e o operador logado
```

E o patch (e2) injetava nela, logo depois do `begin`:

```sql
if not internal.operador_pode_receber_caso(p_email) then return; end if;
```

Medido em produção com as funções de privilégio do próprio Postgres:

```
has_schema_privilege('authenticated','internal','USAGE')  ->  false
has_schema_privilege('anon','internal','USAGE')           ->  false
```

**Consequência que teria acontecido:** toda chamada de heartbeat do receptivo,
feita pela tela de qualquer operador ativo a cada 20 s, falharia com
`42501 permission denied for schema internal`, e a fila do receptivo pararia de
atualizar. O `alter function ... set search_path to 'public','internal'` **não
resolvia** — search_path não concede USAGE.

#### A correção

Um invólucro em `public`, criado na migration 1, ao lado da função `internal`:

```sql
create or replace function public.operador_pode_receber_caso(p_email text)
returns boolean language sql stable security definer
set search_path to 'public', 'internal'
as $fn$ select internal.operador_pode_receber_caso(p_email); $fn$;

revoke all on function public.operador_pode_receber_caso(text) from public, anon;
grant execute on function public.operador_pode_receber_caso(text) to authenticated, service_role;
```

E o patch (e2) passou a chamar `public.operador_pode_receber_caso(p_email)`. As
outras 13, sendo DEFINER, seguem chamando `internal.` direto.

Três decisões, e o porquê de cada uma:

- **Não** `grant usage on schema internal to authenticated`. Abriria o schema
  inteiro, e há função ali com `EXECUTE` para PUBLIC por padrão
  (`internal.matricula_em_fidelizacao`), que passaria a ser chamável de fora.
- **Permissão mínima:** nada para `public` nem `anon`; `EXECUTE` só para
  `authenticated` e `service_role` — exatamente o alcance que
  `fila_receptivo_heartbeat` já tem. Incluir `service_role` não é folga: sem
  isso, chamar o heartbeat por aquele papel quebraria.
- **A validação do operador continua sendo uma só.** O invólucro não decide nada:
  o corpo é a delegação, e a regra (ativo, perfil operador, `recebe_novos_casos`)
  segue vivendo em um único lugar. Deliberadamente **não** pus no invólucro um
  teste de "só pode perguntar por você mesmo": ele seria um caminho novo de
  falha — `service_role` não tem JWT, e se `perfil.email` divergir de
  `auth.email` para alguém, o heartbeat daquela pessoa passaria a estourar. O que
  a pergunta devolve (se um operador pode receber caso) já é visível na tela da
  equipe. Se você preferir o teste, ele é de três linhas e eu acrescento.

`fila_receptivo_heartbeat` **saiu** da lista de `alter function ... set
search_path`, que passou de 9 para **8**: ela não alcança mais o `internal`, e
deixar `internal` no search_path de um papel sem USAGE mentiria sobre o que a
função enxerga.

#### Por que os testes não pegaram, e o que mudou

A bancada PGlite roda como **dono do banco**, que ignora ACL. Ela provava
comportamento, não permissão.

Agora a bancada reproduz os privilégios reais de produção — `authenticated` sem
USAGE no `internal`, com `EXECUTE` no heartbeat e `insert/update/select` em
`fila_receptivo` — e há **9 testes que rodam `set role authenticated`**:

| o teste prova | resultado |
|---|---|
| `internal` segue fechado para `authenticated` e `anon` | ✔ |
| chamar `internal.operador_pode_receber_caso` como `authenticated` é recusado | ✔ com `permission denied for schema internal` |
| o invólucro em `public` responde para `authenticated` | ✔ |
| o invólucro é DEFINER e só `authenticated`/`service_role` executam, nunca `anon` | ✔ |
| o corpo patchado do heartbeat **não cita** `internal.` | ✔ |
| operadora **ativa**: o heartbeat funciona como `authenticated` | ✔ entra na fila |
| **ex-operadora**: o heartbeat passa sem erro e **não** entra na fila | ✔ |
| **ex-operadora** como `authenticated` não assume por nenhuma das 4 portas | ✔ |
| `recebe_novos_casos = false` barra mesmo com a operadora ativa | ✔ |

O segundo é o que importa: ele **falharia** se alguém voltasse o patch para
`internal.`, porque prova que a porta fechada está fechada de verdade.

### 3.4 Gatilhos

`trigger_impor_teto_operador` está **ativo** em `casos`, `AFTER UPDATE`, com
`WHEN (new.operador_email is not null and distinto do antigo)`. Como a Carteira
Geral é um titular explícito e não nulo, **ele dispara nos 539 movimentos.** Não
é problema, e não é por sorte:

```sql
IF NOT EXISTS (SELECT 1 FROM public.usuarios u
               WHERE u.email = v_email AND u.perfil = 'operador' AND u.ativo = true)
THEN RETURN NEW; END IF;
```

A linha da Carteira Geral nasce `perfil='carteira'`, `ativo=false` — o gatilho
retorna na primeira linha. **Nenhum excedente é liberado**, e não precisou de
patch. É o desenho de D1 pagando: titular explícito, sem login, fora da classe
`operador`.

Os outros gatilhos de `acordos` (`trg_aluno_segue_dono_do_acordo`,
`trg_atribuir_responsavel_por_acordo`, `trg_acordo_herda_responsavel`) estão
ativos e dois deles são justamente alvo dos patches (f) e (g).

### 3.5 Cron

**As migrations não criam nem alteram nenhum job.** Nenhuma linha `cron.` nos 4
arquivos. Dos 39 jobs de produção, três tocam função patchada:

| job | horário (UTC) | ativo? | função patchada |
|---|---|---|---|
| `fidelizacao_liberar_vencidos` | 08:20 diário | **sim** | `casos_elegiveis_liberacao_fidelizacao` |
| `nivelamento_automatico_gestao` | 09:20 diário | **sim** | `nivelamento_automatico_gestao` (+ teto, médias) |
| `reposicao_carteira_minuto` | a cada minuto | **não** (pausado) | `reposicao_carteira_processar` |

Consequência para o roteiro: **os dois ativos rodam de manhã, entre 08:20 e
09:20 UTC (05:20–06:20 BRT).** Aplicando durante o dia, há ~23h de margem até a
próxima passada automática. E como o lote da Olga só roda **depois** da
migration 4, a janela de exposição é zero.

`public.carteira_geral_vigia()` **não entra em cron**. O vigia diário é o job 45,
que chama `public.invariantes_rodar()` às 09:10 UTC; a função nova não é chamada
por ele. Hoje ela é um **comando de conferência manual** — está no roteiro. Se
quiser que entre na rodada diária, é um patch à parte em `invariantes_rodar()`.

### 3.6 Tempo — medido em produção, não estimado

`authenticated` tem `statement_timeout = 8s`. `carteira_geral_mover` e
`carteira_geral_desfazer_lote` já sobem o próprio teto para `300s`; **`_previa`,
`_painel` e `_listar` não** — herdam os 8s. Então medi as duas leituras pesadas,
reproduzindo a lógica exata com `explain analyze`:

> **Correção de 26/09.** A primeira versão desta seção dizia "base do painel:
> 296 ms, folga de mais de 20×". **Estava errado, e o erro era meu:** ao
> reproduzir `carteira_geral_base` eu omiti o CTE `alvo` (o filtro "o aluno tem
> alguma dívida"), que é justamente a parte cara. Refeita a medição com a função
> fiel, a base custa **~1 s sozinha**. Os números abaixo são os corretos.

| leitura | escopo | tempo | medido por |
|---|---|---|---|
| `carteira_geral_base('{}')` | carteira inteira, 12.740 linhas | **972 ms** (plano 14,7 ms) | eu, `explain analyze` da função replicada fielmente, 26/09 |
| `count(*) from carteira_geral_base('{}')` | 12.803 linhas | **642 ms** | sessão "Sistema travando", 25/09 |
| `carteira_geral_painel('{}')` — **1ª chamada** | carteira inteira | **2.678 ms** | idem, `clock_timestamp()` em volta da chamada, dentro de bloco que dá `raise` no fim |
| `carteira_geral_painel('{}')` — **quente** | carteira inteira | **945 ms** | idem |
| itens da prévia | os 555 casos vivos da Olga | 239 ms | eu, `explain analyze` |

**Leia assim, e não como "aprovado":** o teto funcional é o `statement_timeout`
de 8 s do papel `authenticated`, e mesmo a pior medição (2,7 s) cabe — com folga
de ~3×, não de 20×. Mas **o alvo de "abrir em menos de 1 s" só é atendido com
cache quente**. A primeira abertura do dia, ou depois de um período parado,
custa perto de 3 s. Se isso incomodar na prática, o caminho é a mesma lição de
23/09 (filtrar antes de enriquecer, `CTE as materialized`), não subir o teto.

Uma armadilha para quem for medir: `carteira_geral_painel` faz
`create temp table _cg on commit drop`. Chamar a função **duas vezes na mesma
transação** dá `relation "_cg" already exists`. Meça uma vez por transação.

A escrita é a incógnita: não posso medir sem executar. Cada aluno move caso +
ficha + acordos + agenda, e cada `update` em `casos` acorda o gatilho do teto.
O limite prático não é o `statement_timeout` de 300s, é o gateway HTTP (~60s).
Por isso o roteiro manda calibrar o tamanho do lote com o primeiro lote pequeno,
em vez de adivinhar.

### 3.7 Reversão — o que existe e o que precisa ser feito à mão

**Não há PITR.** A reversão é por reconstrução, e tem duas metades bem diferentes:

**a) O lote (dados).** `carteira_geral_desfazer_lote(lote_id, motivo)` devolve
cada aluno à titularidade anterior gravada na auditoria e **recusa** item a item
o que foi movido, assumido ou alterado depois do lote.

Achado: **não existe botão para ela na tela.** Ela é `authenticated` + exige
`calibragem_e_gestao()` — que lê `auth.jwt()`. Testei o portão: pelo SQL Editor,
dentro de transação explícita, a claim pode ser posta e o portão abre.
Verificado em produção (leitura):

```
set local request.jwt.claims = '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}';
-> auth.jwt() ->> 'email' = amanda.seibel@aelbra.com.br   -> portão abriria
```

Ou seja: **a porta do desfazer é o SQL Editor**, com a claim posta, e a auditoria
registra o e-mail como autor — que é você mesma. O comando está no roteiro.

**b) Os 15 patches (código).** `internal.patch_funcao_ancorada` só vai para
frente. Desfazer = restaurar o corpo anterior. **Por isso o roteiro tem um passo
de backup obrigatório antes da migration 4**: gravar o `pg_get_functiondef` das
14 funções antes de patchar. Sem esse arquivo não há volta.

### 3.8 Como a interface fica disponível sem estar ativa antes das migrations

Não há feature flag, e não precisa haver — **a ordem é o mecanismo**:

1. A tela só existe depois do merge, porque é o merge que dispara o deploy na
   Vercel.
2. Depois do deploy, ela aparece **só para 3 e-mails**: o item de menu e a
   `RotaProtegida` têm allowlist explícita de `amanda.seibel`, `cobranca04`,
   `cobranca07` (`src/App.jsx:327` e `:724`), e `podeAcessar` já barra operador.
3. Nenhum outro arquivo do front toca a funcionalidade. Conferido: só
   `CarteiraGeral.jsx` e `utils/carteiraGeral.js` mencionam `carteira_geral`,
   `recebe_novos_casos` ou o e-mail do destino. As telas existentes seguem iguais.
4. O portão definitivo é do banco: toda RPC de escrita exige
   `calibragem_e_gestao()` e sessão com JWT.

**Portanto: migrations primeiro, merge depois.** Se a ordem se invertesse, o
único efeito seria a tela nova dar erro de função inexistente para essas 3
pessoas — nada mais quebra. Mas não há razão para inverter.

## 4. Fotografia da Olga hoje — e o que mudou desde 24/09

`cobranca03@aelbra.com.br`. Em `usuarios` ela segue **`ativo = true`, perfil
`operador`**; o login em `auth.users` está vivo, sem ban, último acesso
**11/09**. Igual à conferência anterior: desativar o acesso continua sendo ação
administrativa fora do PR.

Reproduzi a lógica exata de `carteira_geral_base` (inlinando a view
`calibragem_saldo_aluno`, cujo predicado `titulo_superado_por_acordo` é constante
`false` desde 26/08 — portanto inócuo):

| Medida | 24/09 | **hoje** | Δ |
|---|---:|---:|---:|
| Casos (`casos.operador_email`) | 735 | **726** | −9 |
| — vivos | 564 | **555** | −9 |
| — **universo da tela** (vivo + saldo) | 545 | **539** | −6 |
| Valor do universo | 2.546.943,15 | **2.535.279,67** | −11.663,48 |
| — mensalidade | 819.405,33 | **815.336,64** | −4.068,69 |
| — acordo | 1.727.537,82 | **1.719.943,03** | −7.594,79 |
| Fichas (`responsavel_atual_email`) | 721 | **712** | −9 |
| Acordos com responsável = Olga | 356 | **325** | −31 |
| Retornos agendados no universo | 519 | **514** | −5 |
| **Acordos dela que vão junto** | 227 | **195** | **−32** |
| **Acordos de terceiros que ficam** | 159 | **184** | **+25** |
| — em quantos alunos | 145 | **161** | +16 |
| — valor | 651.637,17 | **948.119,26** | **+296.482,09** |

Por ano e tipo, no universo de hoje:

| Ano | Tipo | Alunos | Itens | Valor |
|---:|---|---:|---:|---:|
| 2027 | Acordo | 91 | 136 | 240.045,90 |
| 2026 | Acordo | 278 | 1.002 | 1.421.556,86 |
| 2026 | Mensalidade | 247 | 642 | 591.101,03 |
| 2025 | Acordo | 31 | 92 | 58.340,27 |
| 2025 | Mensalidade | 101 | 402 | 182.353,16 |
| 2024 | Mensalidade | 12 | 41 | 41.882,45 |

### O que causou a mudança — duas coisas, ambas no `aluno_movimentacoes`

**1. A gestão já está fazendo o remanejamento à mão, acordo por acordo.**
Cerca de 30 eventos `ALTERACAO_RESPONSAVEL_ACORDO`, autor `cobranca04`
(Fernanda), de `cobranca03` para `amanda.seibel`, entre **24/09 16:57 e 25/09
13:54** — o último há poucas horas.

O efeito colateral é o que explica os números: **o acordo muda de dono e o caso
continua com a Olga**, então cada movimento desses converte um "acordo dela" em
"acordo de terceiro". Daí −32 / +25 e os R$ 296 mil a mais na coluna de
terceiros. **Não é dado sujo: é titularidade divergente sendo criada agora.**

Isso tem consequência direta na decisão que você ia tomar: aqueles ~30 acordos
hoje são da Amanda, então a prévia vai listá-los como **acordo de terceiro, que
fica** — a menos que sejam selecionados um a um. Pode ser exatamente o desejado
(a Amanda mantém o que assumiu), mas é uma decisão diferente da que a lista de
24/09 apresentava.

**2. Nove casos escorreram para a fila livre.** Nove eventos
`REDISTRIBUICAO_SINCRONIZACAO` ("sincronização automática em tempo real —
gatilho"), de `cobranca03` para nulo, entre 24/09 18:59 e **hoje 13:01**. Conferi
onde estão: **caso e ficha agora sem operador** — fila livre, disponíveis para
qualquer operador assumir. Seis deles tinham saldo (é o −6 do universo).

**Leitura operacional:** enquanto a Carteira Geral não entra, a carteira da Olga
está drenando por dois caminhos ao mesmo tempo — trabalho manual da gestão e
liberação automática para a fila livre, a ~9 casos/dia. Os números vão continuar
se mexendo. **A prévia tem de ser gerada minutos antes de confirmar**, e a
seleção de acordos de terceiros decidida sobre ela, não sobre esta tabela.

---

# 5. Roteiro de aplicação

Três fases, deliberadamente separadas. **A Fase 3 (a carteira da Olga) só começa
depois de a Fase 2 estar verificada e você ter conferido a prévia.**

Regra geral de parada, válida em todo o roteiro:

> **Se qualquer verificação não devolver exatamente o valor esperado, pare ali.**
> Não siga para o passo seguinte, não "ajuste para passar", não reexecute. Cada
> passo abaixo tem um número esperado escrito ao lado justamente para que a
> decisão de parar seja objetiva e não dependa de interpretação.

E uma trava de horário: **os dois cron ativos que tocam função patchada rodam
08:20 e 09:20 UTC.** Aplique depois das 09:30 UTC (06:30 BRT) e você tem o dia
inteiro de margem.

## Reconciliação do histórico — 26/09/2026

As quatro migrations foram aplicadas em produção em **25/09, entre 18:07 e
18:18 UTC**. Quem aplicou usou `apply_migration`, que **gera a versão no momento
da aplicação** e ignora o nome do arquivo. Resultado: o repositório e o
`schema_migrations` passaram a discordar nos números.

**Conciliado renomeando os arquivos para as versões que produção registrou** —
zero SQL executado, zero conteúdo alterado:

A igualdade é **do arquivo sem o newline final** contra
`md5(array_to_string(statements, E'\n'))` em produção — o arquivo do repositório
termina com `\n`, o texto guardado em `schema_migrations` não. Fingerprint
completo, conferido em 26/09:

| arquivo antes | versão registrada | md5 do arquivo **sem o newline final** = md5 dos statements | md5 do arquivo inteiro |
|---|---|---|---|
| `20260924171251_carteira_geral_destino` | **`20260925180744`** | `85856d786fd95176e3687f06cfb5c5c1` ✔ | `baa3a94305dd71b7c3c8d55e065cdc4e` |
| `20260924171252_carteira_geral_painel_previa` | **`20260925181117`** | `446d96dd1b1ec2d2ccbec0e89e3d23bc` ✔ | `6b37a55c2db3e510ef3f7d95ca3484cc` |
| `20260924171254_carteira_geral_mover` | **`20260925181554`** | `ce62ee0e3a987a3b9e24d4e2d742659f` ✔ | `3307ffda0a9d81cfb75d3560eff0d128` |
| `20260924171255_carteira_geral_blindar_automacoes` | **`20260925181823`** | `e2fe786d29f2548c93e62a85f329c544` ✔ | `030050980a0a93a71f43587ac50f5d91` |

E o backup, que não tem arquivo em `migrations/` mas tem no ledger:
`20260925180638`, md5 dos statements `735f3567bbb716cb6e0e47cf8aab56b6`.

Os nomes já batiam; só o carimbo mudou. E o conteúdo **não foi tocado**: é
literalmente o que o banco executou.

Duas consequências que ficam registradas de propósito:

- **Dois** comentários internos ficaram citando as versões antigas: a migration 4
  na linha 197 cita `20260924171251`, e a migration 1 na linha 108 cita
  `20260924171255`. **Não corrigi nenhum dos dois**: mexer no texto mudaria o
  md5 e o arquivo deixaria de ser o que produção rodou. A fidelidade ao aplicado
  vale mais que um comentário atual — e é ela que sustenta a tabela acima.
- `20260925180638_backup_carteira_geral_funcoes_20260925` está em produção e
  **não tem arquivo aqui** — é o backup das 14 funções, e backup é matéria de
  **ledger**, não de migration. **Está no ledger deste PR**, junto das quatro
  (seção de ledger abaixo). O mesmo tratamento foi dado ao backup
  `20260925125311`, da frente do acordo cancelado, que entrou na `main` em 26/09
  pelo PR #530 — com isso o PR #526, que eu havia aberto para as mesmas três
  versões, ficou redundante e deve ser fechado.

### Risco de reaplicação: nenhum pelo caminho automático

| caminho | fala com o banco? |
|---|---|
| CI (`testes, build e catracas`) | **não** — o cabeçalho do workflow diz isso, e a catraca das migrations só lê o checkout |
| build | `vite build`, só isso |
| Vercel | `vercel.json` é só `rewrites` |
| `supabase db push` local | **sim, e aponta para PRODUÇÃO** (`supabase/.temp/linked-project.json` = `ahattpqrjmhkzsmnbdzs`) |

Antes do rename, um `db push` veria as quatro como pendentes e — por serem mais
antigas que a última aplicada — recusaria com *"found local migration files to
be inserted before the last migration on remote database"*, ou as reaplicaria
com `--include-all`. **Depois do rename, ele as vê como aplicadas.**

E mesmo uma reaplicação seria inofensiva: conferi statement a statement, todos
idempotentes — `create or replace function`, `add column if not exists`,
`create table if not exists`, `drop policy/trigger if exists` + create, o único
`insert` com `on conflict (email) do update`, `drop function if exists` das
assinaturas antigas, e os 15 patches, que são idempotentes **pelo texto novo**
(há teste para isso).

## Fase 0 — a correção do bloqueador: FEITA

1. ✔ Invólucro `public.operador_pode_receber_caso` na migration 1, com
   `revoke` de `public`/`anon` e `grant` só para `authenticated`/`service_role`.
2. ✔ Patch (e2) da migration 4 passou a chamá-lo; `fila_receptivo_heartbeat`
   saiu da lista de `alter function` (9 → 8).
3. ✔ A bancada passou a reproduzir os privilégios reais de produção e ganhou
   **9 testes que rodam como `authenticated`** (§3.3).
4. ✔ Âncoras reconferidas contra produção depois da correção: 15 de 15.

**Critério de parada que continua valendo:** se o CI não estiver verde no commit
que você for aplicar, nada da Fase 1 começa.

## Fase 1 — instalar a funcionalidade (nenhum aluno muda de mão)

Aplique **na ordem**, uma por vez, conferindo entre elas. O caminho é
`apply_migration` (o mesmo que funcionou em 23/09), não `db push`.

### Passo 1.1 — backup da reversão (antes de qualquer migration) — FEITO

Aplicado em **25/09 18:06:38 UTC**, versão `20260925180638`. O que rodou de
verdade — e **não** é exatamente o que este roteiro pedia:

```sql
create table public._backup_carteira_geral_funcoes_20260925 as
select n.nspname as schema, p.proname as funcao,
       pg_get_function_identity_arguments(p.oid) as args,
       pg_get_functiondef(p.oid) as definicao_antes,
       now() as capturado_em
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('nivelamento_automatico_gestao','calibragem_simular_nivelamento_impl',
       'reforcar_teto_operadores','nivelar_medias_progressivo','reposicao_carteira_processar',
       'assumir_caso_livre','assumir_caso_livre_aluno','sistema_assumir_atendimento',
       'assumir_atendimento_aluno','sistema_assumir_receptivo','fila_receptivo_heartbeat',
       '_aluno_segue_dono_do_acordo','casos_elegiveis_liberacao_fidelizacao',
       'atribuir_responsavel_por_acordo');

alter table public._backup_carteira_geral_funcoes_20260925 enable row level security;
revoke all on table public._backup_carteira_geral_funcoes_20260925 from anon, authenticated;
```

As duas últimas linhas (`enable row level security` e o `revoke` de `anon` e
`authenticated`) **não estavam** no bloco que eu tinha escrito aqui; quem aplicou
as acrescentou, e com razão: definição de função não é leitura para o app. O
bloco antigo daria md5 `31ef84b7…`; o que produção registrou é
`735f3567bbb716cb6e0e47cf8aab56b6`. **O ledger foi montado a partir de
`schema_migrations.statements`, não deste roteiro** — é a única fonte que
descreve o que o banco executou.

Conferência (feita em 26/09, tudo bateu):

```sql
select count(*)                                            as linhas,          -- 14
       count(*) filter (where coalesce(definicao_antes,'') <> '') as com_corpo, -- 14
       count(*) filter (where b.funcao::text in (
         'nivelamento_automatico_gestao','calibragem_simular_nivelamento_impl',
         'reforcar_teto_operadores','nivelar_medias_progressivo','reposicao_carteira_processar',
         'assumir_caso_livre','assumir_caso_livre_aluno','sistema_assumir_atendimento',
         'assumir_atendimento_aluno','sistema_assumir_receptivo','fila_receptivo_heartbeat',
         '_aluno_segue_dono_do_acordo','casos_elegiveis_liberacao_fidelizacao',
         'atribuir_responsavel_por_acordo'))                as sao_as_certas     -- 14
  from public._backup_carteira_geral_funcoes_20260925 b;
```

**Parar se:** vier diferente de 14 em qualquer coluna. Sem as 14 não há reversão
dos patches.

### Passo 1.2 — migration 1 (`..._destino`)

```sql
select internal.carteira_geral_email()                                     as email,      -- carteira.geral@reativa.local
       (select count(*) from public.usuarios
         where lower(email)=internal.carteira_geral_email()
           and perfil='carteira' and ativo=false)                          as linha_destino,  -- 1
       (select count(*) from auth.users
         where lower(email)=internal.carteira_geral_email())               as tem_login,      -- 0
       (select count(*) from information_schema.columns
         where table_schema='public' and table_name='usuarios'
           and column_name='recebe_novos_casos')                           as coluna,         -- 1
       (select count(*) from public.usuarios where recebe_novos_casos is null) as nulos,       -- 0
       (select count(*) from information_schema.tables
         where table_schema='public'
           and table_name in ('carteira_geral_previas','carteira_geral_auditoria')) as tabelas, -- 2
       (select count(*) from pg_trigger
         where tgname='trg_cg_auditoria_append_only' and not tgisinternal)  as gatilho,        -- 1
       (select count(*) from pg_policies where schemaname='public'
         and tablename in ('carteira_geral_previas','carteira_geral_auditoria')) as politicas;  -- 2
```

**Esperado:** `carteira.geral@reativa.local`, 1, **0**, 1, 0, 2, 1, 2.

E o invólucro de §3.3, com a permissão mínima:

```sql
select has_function_privilege('authenticated','public.operador_pode_receber_caso(text)','EXECUTE') auth,   -- true
       has_function_privilege('service_role','public.operador_pode_receber_caso(text)','EXECUTE')  svc,    -- true
       has_function_privilege('anon','public.operador_pode_receber_caso(text)','EXECUTE')          anon,   -- false
       has_schema_privilege('authenticated','internal','USAGE')                                    interno; -- false
```

**Parar se:** `anon` vier `true`, ou se `interno` vier `true` — abrir o
`internal` para `authenticated` é justamente o que esta correção evita.

**Parar se:** `tem_login` vier diferente de 0 — a Carteira Geral não pode ter
login. Ou se `linha_destino` não for 1 com `ativo=false` e `perfil='carteira'`:
é essa linha que desarma o gatilho do teto (§3.4).

### Passo 1.3 — migration 2 (`..._painel_previa`)

```sql
select count(*) filter (where proname='carteira_geral_base')    as base,     -- 1
       count(*) filter (where proname='carteira_geral_painel')  as painel,   -- 1
       count(*) filter (where proname='carteira_geral_listar')  as listar,   -- 1
       count(*) filter (where proname='carteira_geral_previa')  as previa    -- 1 (so a de 6 args)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'carteira_geral_%';

-- a assinatura antiga de 5 argumentos tem de ter sido derrubada
select pg_get_function_identity_arguments(p.oid)
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='carteira_geral_previa';
-- esperado: exatamente uma linha, terminando em ', uuid[]'

-- base nao pode estar exposta
select has_function_privilege('authenticated','public.carteira_geral_base(jsonb)','EXECUTE');  -- false
select has_function_privilege('authenticated','public.carteira_geral_painel(jsonb)','EXECUTE'); -- true
```

Teste de leitura de verdade, com a claim (não muda nada):

```sql
begin;
set local request.jwt.claims = '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}';
select jsonb_pretty(public.carteira_geral_painel('{}'::jsonb));
rollback;
```

**Esperado:** responde dentro dos 8 s do papel (medido: 2,7 s na 1ª chamada,
0,9 s quente — ver §3.6) e a soma de
`por_responsavel` traz a Olga com ~539 alunos e ~R$ 2,53 mi.

**Parar se:** der timeout, ou se a Olga não aparecer no painel.

### Passo 1.4 — migration 3 (`..._mover`)

```sql
select p.proname, pg_get_function_identity_arguments(p.oid) args,
       (p.proconfig::text like '%300s%') tem_teto_300s
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('carteira_geral_mover','carteira_geral_desfazer_lote','carteira_geral_definir_recebimento')
 order by 1;
```

**Esperado:** 3 linhas; `mover` com `(uuid, text)` — **não** `(uuid, text, boolean)`;
`mover` e `desfazer_lote` com `tem_teto_300s = true`.

```sql
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='internal' and p.proname='carteira_geral_trocar_dono';  -- 1
```

**Parar se:** a assinatura de 3 argumentos de `mover` ainda existir — a tela
chamaria a errada.

### Passo 1.5 — migration 4 (`..._blindar_automacoes`)

Esta é a única que reescreve função que já está em uso. O backup do passo 1.1 é
o que permite voltar.

Verificação de que os 15 patches entraram — conta o **texto novo**, não a
ausência da âncora:

> **Correção de 26/09.** A consulta que estava aqui procurava
> `operador_pode_receber_caso|carteira_geral_email` e **dava falso divergente**:
> cinco dos quinze patches não injetam nenhuma das duas — injetam
> `coalesce(u.recebe_novos_casos, true)` ou um `EXISTS` sobre `usuarios`. Usando
> ela eu cheguei a "6 de 14" e depois a "5 faltando", e quase reportei uma
> instalação pela metade que nunca existiu. **O certo é contar o TEXTO NOVO de
> cada patch**, que é o que a própria `patch_funcao_ancorada` usa para ser
> idempotente:

```sql
with alvo(i, fn, novo_texto, esperado) as (values
  (1,'nivelamento_automatico_gestao',$q$coalesce(u.recebe_novos_casos, true) and not (u.email = any(p_origens))$q$,1),
  (2,'calibragem_simular_nivelamento_impl',$q$u.perfil = 'operador' and coalesce(u.recebe_novos_casos, true)$q$,1),
  (3,'reforcar_teto_operadores',$q$AND EXISTS (SELECT 1 FROM public.usuarios u WHERE lower(u.email) = lower(casos.operador_email) AND u.ativo AND u.perfil = 'operador')$q$,1),
  (4,'nivelar_medias_progressivo',$q$AND EXISTS (SELECT 1 FROM public.usuarios u WHERE lower(u.email) = lower(casos.operador_email) AND u.ativo AND u.perfil = 'operador')$q$,2),
  (5,'reposicao_carteira_processar',$q$u.ativo = true and coalesce(u.recebe_novos_casos, true)) then$q$,1),
  (6,'reposicao_carteira_processar',$q$erro = 'operador inativo ou fora da entrada de casos novos'$q$,1),
  (7,'assumir_caso_livre',$q$internal.operador_pode_receber_caso(v_email)$q$,1),
  (8,'assumir_caso_livre_aluno',$q$internal.operador_pode_receber_caso(v_email)$q$,1),
  (9,'sistema_assumir_atendimento',$q$internal.operador_pode_receber_caso(v_email)$q$,1),
  (10,'assumir_atendimento_aluno',$q$internal.operador_pode_receber_caso(v_email)$q$,1),
  (11,'sistema_assumir_receptivo',$q$internal.operador_pode_receber_caso(v_email)$q$,1),
  (12,'sistema_assumir_receptivo',$q$internal.carteira_geral_email()$q$,1),
  (13,'fila_receptivo_heartbeat',$q$public.operador_pode_receber_caso(p_email)$q$,1),
  (14,'_aluno_segue_dono_do_acordo',$q$internal.carteira_geral_email()$q$,1),
  (15,'casos_elegiveis_liberacao_fidelizacao',$q$lower(c.operador_email) <> internal.carteira_geral_email()$q$,1),
  (16,'atribuir_responsavel_por_acordo',$q$lower(new.operador_responsavel_email) = internal.carteira_geral_email()$q$,1)
)
select a.i, a.fn, a.esperado,
       (select count(*) from regexp_matches(pg_get_functiondef(p.oid),
          regexp_replace(a.novo_texto,'([\^$.|?*+()\[\]{}\\])','\\\1','g'),'g')) as achou,
       case when (select count(*) from regexp_matches(pg_get_functiondef(p.oid),
          regexp_replace(a.novo_texto,'([\^$.|?*+()\[\]{}\\])','\\\1','g'),'g')) >= a.esperado
            then 'OK' else 'FALTANDO' end as veredito
  from alvo a
  join pg_proc p on p.proname = a.fn
  join pg_namespace n on n.oid = p.pronamespace and n.nspname='public'
 order by a.i;
```

**Esperado: 16 linhas, todas `OK`.** São 16 e não 15 porque o patch de
`sistema_assumir_receptivo` injeta duas linhas (itens 11 e 12), e
`nivelar_medias_progressivo` tem a mesma inserção em 2 lugares.
**Medido em produção em 26/09: 16 de 16.**

> **Correção de 26/09.** A consulta anterior não filtrava pelas 14 funções e
> devolvia **29** linhas — todas as funções de `public` que têm `internal` no
> `search_path`, a maioria anterior a este pacote. Filtrada, dá exatamente 8.

```sql
select p.proname, p.proconfig
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proconfig::text like '%internal%'
   and p.proname in ('nivelamento_automatico_gestao','calibragem_simular_nivelamento_impl',
       'reforcar_teto_operadores','nivelar_medias_progressivo','reposicao_carteira_processar',
       'assumir_caso_livre','assumir_caso_livre_aluno','sistema_assumir_atendimento',
       'assumir_atendimento_aluno','sistema_assumir_receptivo','fila_receptivo_heartbeat',
       '_aluno_segue_dono_do_acordo','casos_elegiveis_liberacao_fidelizacao',
       'atribuir_responsavel_por_acordo')
 order by 1;
```

**Esperado: exatamente 8 linhas**, todas com `search_path=public, internal`, e
`fila_receptivo_heartbeat` **fora** da lista (ver §3.3 — ela chama o invólucro em
`public`, não alcança o `internal`).

E o corpo patchado do heartbeat não pode citar o `internal`:

```sql
select position('internal.' in pg_get_functiondef(p.oid)) = 0 as limpo,
       position('public.operador_pode_receber_caso(p_email)' in pg_get_functiondef(p.oid)) > 0 as tem_involucro
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='fila_receptivo_heartbeat';
```

**Esperado:** `true`, `true`. **Parar se** `limpo` vier `false`.

**A verificação que o preflight de hoje mostrou ser indispensável** — provar que
o operador comum continua conseguindo bater o heartbeat:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"email":"cobranca05@aelbra.com.br","role":"authenticated"}';
select public.fila_receptivo_heartbeat('cobranca05@aelbra.com.br','teste', false);
rollback;
```

(`cobranca05` e a Luana, operadora ativa conferida hoje; qualquer uma das 7
ativas serve — a Olga nao, porque ela e justamente quem deve ser barrada)

**Esperado:** executa sem erro. **Parar se** vier
`42501 permission denied for schema internal` — é o bloqueador de §3.3 e
significa que a Fase 0 não foi feita ou não ficou certa. Reverta a migration 4
pelo backup antes de sair.

E o vigia, que não tem cron (§3.5):

```sql
select jsonb_pretty(public.carteira_geral_vigia());
```

**Esperado:** com a Carteira Geral ainda vazia, todos os contadores em 0.

### Passo 1.6 — merge e deploy

Só agora. Merge do PR → deploy na Vercel → a tela aparece para os 3 e-mails.

**Verificação:** entre com o seu login, abra **Gestão → Carteira Geral**, confira
que o painel traz a Olga com ~539 alunos. Pedir para a Fernanda e a Amanda ADM
confirmarem que também veem o menu. Um operador qualquer **não** pode ver o item.

**Parar se:** algum operador vir o menu.

## Fase 2 — fechar a porta de entrada da Olga (sem mover nada)

```sql
begin;
set local request.jwt.claims = '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}';
select public.carteira_geral_definir_recebimento('cobranca03@aelbra.com.br', false,
       'Desligamento — nao recebe novos casos');
commit;
```

**Verificação:**

```sql
select email, ativo, recebe_novos_casos from public.usuarios
 where lower(email)='cobranca03@aelbra.com.br';                   -- recebe_novos_casos = false
select internal.operador_pode_receber_caso('cobranca03@aelbra.com.br');  -- false
select count(*) from public.auditoria
 where tabela_afetada='usuarios' and detalhes::text ilike '%cobranca03%'
   and criado_em > now() - interval '5 min';                      -- >= 1
```

**Parar se:** `operador_pode_receber_caso` não vier `false`. É essa função que os
15 patches consultam; sem ela em `false`, a blindagem não blinda.

**O que isto ainda NÃO faz:** o login dela continua vivo em `auth.users`
(conferido hoje: sem ban, último acesso 11/09). Desativar o acesso é ação
administrativa no painel do Supabase, **fora deste PR** — e continua sendo
decisão sua.

## Fase 3 — o remanejamento real da Olga

**Nada aqui é automático e nada aqui é irreversível às cegas.**

### 3.1 Antes de abrir a tela, tire a fotografia do dia

Rode a consulta da §4 deste documento e anote os números **daquele momento**.
Eles não vão bater com os desta página: conforme §4, a carteira está mudando
todo dia (trabalho manual da gestão + ~9 casos/dia escorrendo para a fila livre).

### 3.2 Gere a prévia na tela, em lote pequeno primeiro

Selecione **25 alunos**, destino Carteira Geral, e confirme. Cronometre.

**Critérios objetivos:**

| Observação | Decisão |
|---|---|
| respondeu em ≤ 10s | siga com lotes de 100 |
| respondeu entre 10s e 30s | lotes de 50 |
| respondeu > 30s, ou deu erro de gateway | **pare** — lotes de 25 e me chame |
| `alunos_recusados_por_acordo` > 0 | **pare** e leia o motivo antes de continuar |
| a prévia trouxe `TETO_DO_OPERADOR` | não deveria acontecer com destino Carteira Geral — **pare** |

Verificação após o primeiro lote:

```sql
select destino_tipo, count(*) alunos, count(distinct lote_id) lotes
  from public.carteira_geral_auditoria
 where registrado_em > now() - interval '30 min'
 group by 1;

select jsonb_pretty(public.carteira_geral_vigia());
```

**Esperado:** o número de alunos igual ao que a tela disse ter movido, e o vigia
sem nenhuma inconsistência apontada.

E a prova de que o agendamento sobreviveu (é a promessa mais delicada do PR):

```sql
select count(*) filter (where c.data_retorno is not null)          as com_retorno,
       count(*) filter (where c.data_retorno is not null
                          and lower(c.operador_email)=internal.carteira_geral_email()) as no_destino
  from public.casos c
 where c.aluno_id in (select aluno_id from public.carteira_geral_auditoria
                       where lote_id = '<lote_id do primeiro lote>');
```

**Esperado:** os dois números iguais, e iguais ao que a prévia anunciou em
`RETORNO_AGENDADO_SEGUE`. **Parar se** divergir em 1.

### 3.3 Os acordos de terceiros

Hoje são **184, em 161 alunos, R$ 948 mil** — e ~30 deles são acordos que a
Fernanda passou para a Amanda nas últimas 24h (§4). A regra do PR é: **acordo de
terceiro só vai junto se for marcado um a um.**

Decida na tela, sobre a prévia do dia, olhando de quem é cada acordo. O padrão
(nada marcado) deixa todos com os donos atuais — o que, para os ~30 da Amanda,
provavelmente é o que você quer.

### 3.4 Se precisar desfazer

Não há botão. Pelo SQL Editor:

```sql
begin;
set local request.jwt.claims = '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}';
select jsonb_pretty(public.carteira_geral_desfazer_lote('<lote_id>', 'motivo do desfazer'));
commit;
```

Ela devolve o que estava intacto e **recusa item a item** o que foi mexido depois
do lote, dizendo o motivo. Leia o `recusados` do retorno antes de considerar o
desfazer concluído.

### 3.5 Se precisar reverter os 15 patches

```sql
-- confira o que vai ser restaurado
select funcao, args from public._backup_carteira_geral_funcoes_20260925 order by 1;
-- e execute cada `definicao_antes` como comando, uma por uma, conferindo entre elas
```

Ordem da desinstalação completa, se chegar a isso: **4 → 3 → 2 → 1**. A 1 é a
última porque a coluna `recebe_novos_casos` e
`internal.operador_pode_receber_caso` são o que os patches consultam.

## Proposta, NÃO aplicada: portão de gestão no `carteira_geral_vigia`

Medido em produção em 26/09:

```
prosecdef = true         acl: postgres=X | authenticated=X | service_role=X
portão calibragem_e_gestao() no corpo:  NÃO
has_function_privilege('authenticated', ..., 'EXECUTE') -> true
has_function_privilege('anon',          ..., 'EXECUTE') -> false
```

Ou seja: **qualquer pessoa logada** — inclusive um operador comum — pode chamar
`public.carteira_geral_vigia()` e ler quantos casos e acordos estão na Carteira
Geral, quantas saídas ocorreram sem auditoria e, o que mais importa, a lista
`operadores_sem_entrada_de_casos` — **os nomes de quem está inativo ou com a
entrada de casos novos fechada pela gestão**.

Os números da carteira seriam um vazamento pequeno. A lista de nomes não é:
é informação de pessoal, e ela responde "quem a gestão desligou" para qualquer
colega que saiba chamar a função. É o mesmo tipo de portão que `carteira_geral_painel`,
`_listar`, `_previa`, `_mover`, `_desfazer_lote` e `_definir_recebimento` já têm.

**Correção proposta** — `sql` vira `plpgsql` só para caber o portão; o miolo do
`jsonb_build_object` fica **idêntico**:

```sql
create or replace function public.carteira_geral_vigia()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'internal'
as $fn$
begin
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para ver o vigia da Carteira Geral.' using errcode = '42501';
  end if;
  return (
    -- ... o mesmo jsonb_build_object de 20260925181823, sem uma vírgula mudada
  );
end;
$fn$;
```

**Mantendo o `grant execute ... to authenticated`.** Isso é deliberado e segue a
regra da casa: restringir à gestão é portão **interno**, nunca `revoke` de
`authenticated` — foi assim que eu já derrubei uma tela para a própria gestão em
12/09.

**Efeito colateral que precisa entrar no roteiro junto:** com o portão, chamar o
vigia pelo SQL Editor **sem** a claim de gestão passa a dar `42501`. O Passo 1.5
e qualquer conferência posterior precisam abrir com

```sql
set local request.jwt.claims = '{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}';
```

dentro de transação explícita — o mesmo procedimento já documentado em §3.7 para
o `carteira_geral_desfazer_lote`.

**Não apliquei, e não deve entrar junto com este pacote.** A migration
`20260925181823` já está em produção e conferida; mexer nela agora quebraria a
igualdade byte a byte entre o arquivo e o que o banco executou, que é a base de
toda a reconciliação da §Reconciliação. Isto é uma migration nova, pequena, para
uma etapa própria — com teste que prove negativo para operador, `anon` e sessão
sem JWT, e positivo para os três e-mails da gestão com saída idêntica à de hoje.

## Resumo do que este preflight deixa em aberto

| # | Pendência | De quem |
|---|---|---|
| 1 | ~~Bloqueador de §3.3~~ — **corrigido**, com 9 testes como `authenticated` | feito |
| 2 | Desativar/banir o login da Olga em `auth.users` | administrativo, fora do PR |
| 3 | `carteira_geral_vigia()` não entra na rodada diária — hoje é comando manual | decidir se vale patch em `invariantes_rodar()` |
| 4 | `carteira_geral_desfazer_lote` não tem botão; a porta é o SQL Editor com a claim | decidir se vale botão na tela |
| 5 | O teste de "só pode perguntar por você mesmo" no invólucro — deixei fora de propósito (§3.3) | sua decisão |
| 6 | **Portão de gestão no `carteira_geral_vigia`** — hoje qualquer operador logado lê a lista de quem a gestão desligou. Proposta escrita, **não aplicada** | sua decisão, em migration própria |
| 7 | Abertura do painel custa ~2,7 s na 1ª chamada (§3.6). Cabe nos 8 s, mas não no alvo de 1 s | sua decisão se vale otimizar |
