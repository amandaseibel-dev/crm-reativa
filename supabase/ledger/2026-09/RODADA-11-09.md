> **Nota de 12/09/2026.** Este arquivo nasceu em `supabase/migrations/` como
> `LEIA-ME-20260911.md`. Agora vive no ledger, junto do SQL que descreve. Onde o texto
> diz "tem arquivo aqui", o arquivo esta em
> `supabase/ledger/2026-09/<version>__<nome>.sql` — **nao** em
> `supabase/migrations/`. Os caminhos `../aguardando_aprovacao/` passam a ser
> `../../aguardando_aprovacao/`.

# Migrations de 11/09/2026 — repo × produção: FECHADO

Treze migrations aplicadas em produção nesta data. **Nove são mudança de schema
e têm arquivo aqui. Quatro são execuções pontuais** (rodar o vigia na mão,
capturar o resultado do ensaio, provar o dry-run em transação read only) — não
alteram estrutura e não têm arquivo, de propósito.

| versão | nome | arquivo |
|---|---|---|
| 20260911204433 | crons_sob_carga_portao_jsonb | ✅ |
| 20260911205217 | backup_fn_casos_reabrir_com_divida_antes_conserto3 | ✅ |
| 20260911205305 | caso_faltando_para_aluno_com_divida | ✅ (no-op; aplicada e revertida) |
| 20260911223837 | fase1_pausa_escritas_automaticas_aguardando_aprovacao | ✅ |
| 20260911223954 | fase1_executa_vigia_invariantes_manual | execução pontual |
| 20260911230958 | vigia_cinco_invariantes_cegos | ✅ |
| 20260911231006 | fase1_executa_vigia_apos_cinco_invariantes | execução pontual |
| 20260911231124 | fluxo_acordos_ensaio_sem_escrita | ✅ |
| 20260911231154 | fase1_captura_resultado_do_ensaio | execução pontual |
| 20260911231238 | fase1_prova_dryrun_isolada_em_subtransacao | execução pontual |
| 20260911231349 | pagamento_suspeita_duplicidade_estrutura | ✅ |
| 20260911231510 | bordero_fila_caso_faltando_opcao_b | ✅ |
| 20260911233508 | excecao_conciliacao_nao_acionar_3_casos | ✅ |

## Como as quatro que faltavam foram fechadas

Sem `supabase db pull`. O histórico do Supabase guarda o SQL exato em
`supabase_migrations.schema_migrations.statements` (`text[]`), então os arquivos
foram gerados **a partir de produção** e conferidos por md5:

| arquivo | md5 (conteúdo sem newline final) | md5 idêntico ao de produção? |
|---|---|---|
| 20260911204433_crons_sob_carga_portao_jsonb.sql | `a27decb4bce9efff4b46210dcf0805da` | sim — **regerado em 12/09** |
| 20260911205217_backup_fn_casos_reabrir_com_divida_antes_conserto3.sql | `e286c4414a1a668a8e2873972673bbfc` | sim |
| 20260911205305_caso_faltando_para_aluno_com_divida.sql | `43165eb0e7a754039364f8286db20d86` | sim — **regerado em 12/09** |
| 20260911223837_fase1_pausa_escritas_automaticas_aguardando_aprovacao.sql | `d1a9a65fb34beb1d2981bedf701f894f` | sim — **regerado em 12/09** |
| 20260911230958_vigia_cinco_invariantes_cegos.sql | `90a608c15e862a45ba4c8b83a203ee00` | **não** — ver nota abaixo |
| 20260911231124_fluxo_acordos_ensaio_sem_escrita.sql | `2f89c8d0f8fab78b8cdde8c51b355b48` | sim |
| 20260911231349_pagamento_suspeita_duplicidade_estrutura.sql | `212cd64987ad37c2e97823c098de55ae` | sim |
| 20260911231510_bordero_fila_caso_faltando_opcao_b.sql | `4f433527fac1ab23c63ddccde162c564` | sim |
| 20260911233508_excecao_conciliacao_nao_acionar_3_casos.sql | `574b2784663d035adfef25e4ddb3273b` | sim |

### Três arquivos regerados em 12/09/2026

`20260911204433`, `20260911205305` e `20260911223837` foram escritos à mão
**antes** de aplicar, então os bytes do arquivo divergiam dos `statements`
gravados. Foram regerados a partir de produção e agora batem.

Atenção ao `20260911205305`: o arquivo anterior era um `select 1;` no-op com o
histórico em comentários, porque a migration foi aplicada e depois revertida.
O arquivo agora carrega **o SQL que realmente rodou** — a função
`casos_reabrir_com_divida` com o CONSERTO 3, que cria ficha para aluno com
dívida e sem caso. Isso é fiel a produção, e a migration imediatamente seguinte
(`20260911223837`) restaura a definição anterior a partir do backup criado por
`20260911205217`. Num replay sequencial o estado final é o correto. O risco
existe só num replay que pare **entre** as duas.

### A exceção: `20260911230958_vigia_cinco_invariantes_cegos.sql`

O arquivo tem o **mesmo SQL** que produção, mas não os mesmos bytes:

* um cabeçalho de comentário de **2.087 bytes** explicando por que cinco
  invariantes entraram e por que o sexto ficou desligado — documentação que não
  existe nos `statements`;
* duas linhas de comentário redigidas de forma diferente no meio do corpo.

Medido por md5 de blocos de 2.000 bytes: **idêntico até o byte 10.000**; a
divergência começa num comentário sobre `baixa_manual_na_parcela_errada`.
Arquivo 16.407 bytes × produção 14.217 bytes.

Mantido com o cabeçalho de propósito — a documentação vale mais que a paridade
de bytes num comentário. Se a paridade de md5 for o critério, o arquivo pode ser
regerado a partir dos `statements` e esta nota vira o lugar da documentação.

Para reconferir a qualquer momento:

```sql
select version, name, md5(array_to_string(statements, E'\n')) as md5_prod
  from supabase_migrations.schema_migrations
 where version >= '20260911200000' order by version;
```

```bash
cd supabase/migrations
perl -0pe 's/\n\z//' <arquivo>.sql | md5 -q
```
