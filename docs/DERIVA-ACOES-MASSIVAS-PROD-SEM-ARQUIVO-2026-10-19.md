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
| `acoes_massivas_universo(jsonb)` | `f49209f6` / 13.970 | cadeia dá `3c1fa046` / 13.598 | **comportamento**: lê `responsaveis_caso`, `responsaveis_acordo` e `retorno_origem` |
| `fn_atualizar_ultimo_acionamento()` | `e1bfc393` / 987 | `20261003083400` grava `new.registrado_em::date` | **comportamento**: prod usa `(... at time zone 'America/Sao_Paulo')::date` |
| `acoes_massivas_fora_do_universo()` | `c2c7514c` / 1.075 | **não existe em arquivo nenhum** | função nova, leitura pura (auditoria) |
| `fn_sync_acionamento_alunos_para_casos()` | `ea3034d6` / 456 | `20260806190000` já usa `America/Sao_Paulo` | provavelmente igual — **md5 do arquivo não medido** |

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
- não mexe no `fn_sync_acionamento_alunos_para_casos` antes de medir o md5 do arquivo;
- não toca em nenhuma outra frente do CRM.

## 5. Como foi medido

- versões e `statements`: `supabase_migrations.schema_migrations`;
- corpos vivos: `pg_get_functiondef` e `md5(prosrc)` via MCP somente-leitura;
- cadeia do repo: bancada PGlite de `supabase/tests/fixtures/acoes_massivas_universo/`
  em worktree limpo de `origin/main`, sem os arquivos não versionados da árvore local;
- diferença de `registrar_acao_massiva`: `diff` entre os dois `pg_get_functiondef`.
