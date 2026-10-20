# Deriva das Ações Massivas: o que roda em produção e não está no Git

**19/10/2026 — SÓ LEITURA. Nada neste documento foi aplicado, reaplicado ou revertido.**

Levantado ao entregar a tabulação da ação massiva (versão `20261019132433`). Medido
contra `origin/main` em `a91e891f` e contra os corpos vivos em produção, lidos por
`pg_get_functiondef` / `pg_proc.prosrc`.

## 1. Correção de um erro meu, antes de tudo

Eu afirmei nesta sessão que havia **quatro migrations em produção ausentes do Git**.
Está errado em dois pontos, e a versão correta é esta:

- `acoes_massivas_responsaveis_por_lado` **não existe** em
  `supabase_migrations.schema_migrations` sob nenhuma versão (busca por nome exato e
  por `%por_lado%`: zero linhas). O arquivo `20261006113000_...sql` existe apenas na
  árvore de trabalho local, fora do Git. O **comportamento**, porém, está vivo em
  produção (o `acoes_massivas_universo` real lê `responsaveis_caso` e
  `responsaveis_acordo`), então ele foi aplicado por fora do registro.
- `registrar_acao_massiva` **não tem deriva de comportamento**. A diferença entre a
  cadeia do repo e produção é de **391 caracteres de comentário**, em 3 blocos, e
  mais nada. O `diff` dos dois corpos acusa só linhas `--`.

Portanto: **3 versões registradas sem o SQL** + **1 comportamento aplicado sem
registro nenhum** + **1 função que existe só em produção**.

## 2. As 3 versões registradas de 15/10 guardaram descrição, não SQL

`schema_migrations.statements` dessas três versões contém texto em português, não
comando. Logo **o SQL não é recuperável do registro** — o corpo vivo é a única fonte.

| version | name | statements guardados | bytes |
|---|---|---|---|
| 20261015124500 | retorno_futuro_so_bloqueia_agendamento_do_operador | "patch ancorado 1: a CTE pop passa a ler a.retorno_origem" / "patch ancorado 2: f_ret so bloqueia quando upper(coalesce(retorno_origem,'')) like 'OPERADOR%'" | 152 |
| 20261015154500 | data_ultimo_acionamento_do_caso_no_fuso_de_brasilia | "patch ancorado: casos.data_ultimo_acionamento passa a usar o dia de America/Sao_Paulo (2 ocorrencias)" | 101 |
| 20261015155000 | acoes_massivas_fora_do_universo | "create function + comment + revoke public/anon + grant authenticated/service_role" | 81 |

## 3. Inventário objeto por objeto

| Objeto vivo em produção | md5 / chars em prod | Estado na main | Natureza da diferença |
|---|---|---|---|
| `registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)` | `633a4ebe` / 6.774 (após 19/10) | reproduzido byte a byte pelo arquivo desta branch | **nenhuma** — provado no teste |
| `acoes_massivas_universo(jsonb)` | `f49209f6` / 13.970 | **capturado byte a byte** em `supabase/audits/acoes_massivas_universo_corpo_vivo_producao_20261019.sql` | **comportamento**: lê `responsaveis_caso`, `responsaveis_acordo` e `retorno_origem` |
| `fn_atualizar_ultimo_acionamento()` | `e1bfc393` / 987 | `20261003083400` grava `new.registrado_em::date` | **comportamento**: prod usa `(... at time zone 'America/Sao_Paulo')::date` |
| `acoes_massivas_fora_do_universo()` | `c2c7514c` / 1.075 | **não existe em arquivo nenhum** | função nova, leitura pura (auditoria) |
| `fn_sync_acionamento_alunos_para_casos()` | `ea3034d6` / 456 | `20260806190000` | **nenhuma** — md5 do corpo do arquivo medido depois e igual ao vivo |

### O risco concreto, e é um só

`fn_atualizar_ultimo_acionamento` é o único caso em que **o arquivo do repo é pior
que produção**: ele grava o dia em UTC. Quem reaplicar a cadeia do repo sobre
produção faz `casos.data_ultimo_acionamento` voltar ao dia errado perto da virada —
e esse campo governa fidelização de 10 dias, "nunca acionado" e cobertura. Ver
[`prazo-10-dias-protegido-em-todos-os-caminhos`] na memória do projeto.

Os outros três não regridem nada se nada for reaplicado: são adições em produção.

## 4. Regularização proposta — documental, sem reaplicar

A regra: **não se reescreve em produção o que já está certo em produção**. O que falta
é o Git passar a dizer a verdade.

1. **Capturar cada corpo vivo como arquivo documental**, um por objeto, gerado por
   `pg_get_functiondef`, com `md5` e `chars` no cabeçalho e a frase "NÃO REAPLICAR —
   registro documental". Destino natural: `supabase/migrations_historicas_nao_comprovadas/`,
   que existe para isso. Mesmo padrão já usado em
   `supabase/tests/fixtures/acoes_massivas_universo/prod_20261019_registrar_acao_massiva.sql`,
   cuja transcrição foi provada por md5.
2. **Travar os md5 vivos em teste**, como o teste da tabulação faz: um caso que lê
   `pg_proc` e compara com a constante. Deriva futura quebra alto em vez de passar.
3. **`fn_atualizar_ultimo_acionamento`**: além do registro documental, marcar o
   arquivo `20261003083400` como superado, para ninguém reaplicar a versão UTC.
4. **`acoes_massivas_responsaveis_por_lado`**: o arquivo existe na árvore local e o
   comportamento está vivo. Conferir se ele reproduz o corpo vivo por md5 e, se
   reproduzir, versioná-lo como está — é o caso mais barato dos cinco.
5. **Ledger**: uma linha por versão, tipo `ESTRUTURAL`, `arquivo = -`, nota dizendo
   que `statements` guardou descrição e não SQL. `supabase/ledger/**` está no **deny**
   das permissões, então essas linhas são entregues para aplicação autorizada.

### O que esta proposta NÃO faz, de propósito

- não roda migration, backfill, merge ou qualquer escrita em produção;
- não reescreve nenhuma das 4 funções vivas;
- não mexe no `fn_sync_acionamento_alunos_para_casos`: medido depois, não tem deriva;
- não toca em nenhuma outra frente do CRM.

## 5. Como foi medido

- versões e `statements`: `supabase_migrations.schema_migrations`;
- corpos vivos: `pg_get_functiondef` e `md5(prosrc)` via MCP somente-leitura;
- cadeia do repo: bancada PGlite de `supabase/tests/fixtures/acoes_massivas_universo/`
  em worktree limpo de `origin/main`, sem os arquivos não versionados da árvore local;
- diferença de `registrar_acao_massiva`: `diff` entre os dois `pg_get_functiondef`.

## 6. Estado da regularização (19/10, autorizada por ela)

Feito, e tudo somente leitura:

- **`supabase/audits/acoes_massivas_deriva_corpos_vivos_producao_20261019.sql`** — registro
  documental com os corpos vivos de `fn_atualizar_ultimo_acionamento` e
  `acoes_massivas_fora_do_universo` transcritos **byte a byte** (md5 conferido), a
  identidade de `acoes_massivas_universo` sem o corpo e a razão medida disso, e as
  anotações de que `fn_sync_acionamento_alunos_para_casos` e `registrar_acao_massiva`
  não têm deriva. O arquivo abre com uma guarda que **aborta** se alguém o executar
  inteiro, e diz NÃO REAPLICAR no cabeçalho.
- **`supabase/tests/deriva_corpos_vivos_20261019_integridade.test.js`** — 11 casos que
  conferem, a cada CI, que cada corpo transcrito ainda bate com o md5 e o tamanho de
  produção, que a guarda vem antes do primeiro `CREATE`, que a lacuna do universo está
  registrada com os números medidos e que nenhum corpo transcrito encosta em
  `status_jornada`.

Pendente, e depende de autorização: as linhas de ledger das 3 versões de 15/10
(`supabase/ledger/**` está no `deny`), versionar o
`20261006113000_acoes_massivas_responsaveis_por_lado.sql` que existe só na árvore local,
e, se ela quiser fechar o universo byte a byte, capturar o `pg_get_functiondef` dele.

Nada foi aplicado, reaplicado, revertido ou migrado.

## 7. Fechamento de 19/10 (segunda rodada, autorizada)

### 7.1 O corpo do universo está capturado byte a byte

`supabase/audits/acoes_massivas_universo_corpo_vivo_producao_20261019.sql` tem a
definição inteira lida de produção: `prosrc` **md5 f49209f6 / 13.970 chars**,
definição completa **md5 425a3961 / 14.609 chars / 276 linhas**.

Capturado em 5 pedaços por faixa de linha, cada um conferido pelo seu próprio md5
antes de juntar, e só então o md5 do conjunto. Foi esse método que pegou o único
erro que cometi na transcrição — uma barra invertida dobrada em `'\D'` —, num
pedaço específico, em vez de deixar passar em silêncio.

### 7.2 Correção: a "lacuna de 41 caracteres" não existia

Eu havia escrito que a diferença entre o repo e produção neste objeto era de
"41 caracteres e 5 linhas, formatação e um comentário". **Estava errado.** Aquilo
veio de contagem de caracteres sobre uma reconstrução que misturava o arquivo
local `por_lado` (que não é o que roda) com a cadeia da main sem a migration do
giro. Com o corpo vivo em mãos, o `diff` mostra implementações **diferentes**, não
formatação.

### 7.3 O arquivo local `por_lado` NÃO foi versionado, e está provado por quê

| arquivo local (não aplicado) | produção (vivo) |
|---|---|
| chaves `responsaveis_mensalidade` / `responsaveis_acordo` | chaves `responsaveis_caso` / `responsaveis_acordo` |
| helper `acoes_massivas_normalizar_responsaveis(...)` | parsing inline com `jsonb_array_elements_text` |
| `v_rm` / `v_multi` / `v_pref`, CTE `respac` | `v_rc` / `v_ra`, CTE `parc_dono` |
| sentinelas `'todos'` e `'livres'` | sentinela `'sem_responsavel'` |
| **não** tem `giro_fidelizado` | tem `f_giro` e `giro_fidelizado` |

E o helper **não existe em produção** (conferido: 0 funções com esse nome). A tela
da main manda `responsaveis_caso`, isto é, acompanha produção. Versioná-lo
colocaria no repo uma função que divergiria de produção na primeira reaplicação.

O motivo `giro_fidelizado`, esse sim, já está versionado: veio de
`20261016190000_giro_carteiras_2026_1_2026_2.sql`, que está na main.

### 7.4 Risco UTC/Brasília e a proteção que foi posta

**O risco.** `casos.data_ultimo_acionamento` governa fidelização de 10 dias,
"nunca acionado" e cobertura. Produção grava o dia de `America/Sao_Paulo`
(2 ocorrências, no `SET` e no `WHERE`); o arquivo `20261003083400` do repo grava
`new.registrado_em::date`, em **UTC**. Perto da virada do dia os dois divergem, e
reaplicar o arquivo antigo faria o campo regredir — silenciosamente, porque nada
no sistema reclama de uma data um dia menor.

**A proteção posta agora**, em
`supabase/tests/deriva_corpos_vivos_20261019_integridade.test.js`:

1. o estado correto está registrado no repo e o teste confere o md5 dele e as
   **2 ocorrências** do fuso;
2. qualquer migration **a partir de** `20261015154500` que redefina
   `fn_atualizar_ultimo_acionamento` tem de conter `America/Sao_Paulo`, senão o CI
   quebra;
3. o teste exige que o risco continue documentado e que o arquivo de 03/10 apareça
   na lista de quem define o gatilho — para ninguém tratar a regressão como teórica.

**O que NÃO foi feito, de propósito:** não reescrevi o arquivo histórico de 03/10.
Ele é o registro do que foi aplicado naquele dia; reescrever histórico esconderia
a deriva em vez de documentá-la. E nada foi aplicado em produção.
