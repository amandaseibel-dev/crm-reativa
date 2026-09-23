# Reconciliação de `schema_migrations` — Bloco A (leitura e documentação)

Medição de **23/09/2026** contra `supabase_migrations.schema_migrations` do
projeto `ahattpqrjmhkzsmnbdzs` (**produção**).

> **Nada foi alterado para produzir este documento.** Nenhuma migration foi
> aplicada, removida ou reaplicada; nenhuma linha da tabela de controle foi
> tocada. Todas as consultas abaixo são `select`.

Este arquivo é o Bloco A. O Bloco B (plano de execução) e o Bloco C
(reconciliação em si) **não foram executados** e dependem de decisão da gestão.

## 1. Os números de hoje

| | 12/09/2026 (`DUAS-TRILHAS.md`) | **23/09/2026** |
|---|---|---|
| versões em produção | 1.238 | **1.398** |
| arquivos em `supabase/migrations/` | 451 versões | 532 arquivos / **509 versões** |
| **interseção** | 41 | **26** |
| só no repositório | 410 | **483** |
| só em produção | 1.197 | **1.372** |
| timestamps duplicados no repositório | 22 | **21** |

Composição da interseção de hoje:

* **9** versões terminadas em `0000` — as únicas que o CLI enviou por arquivo
  (lote do WhatsApp de 17–19/08 mais `rls_tabelas_backup` de 26/07). **Todas as
  9 têm arquivo no repositório.**
* **17** versões com timestamp real que também existem como arquivo
  (27/08, 08–09/09 e 15/09).

Em produção, **1.389 das 1.398** versões têm timestamp real — ou seja, foram
aplicadas por `apply_migration`, que grava o SQL em `schema_migrations` e **não
cria arquivo**. Apenas 9 vieram de arquivo. A tabela ocupa 3.760 kB e tem
**2 linhas sem `statements`**.

## 2. A anomalia que este bloco encontrou e NÃO resolveu

**A interseção caiu de 41 para 26 enquanto os dois lados cresceram.**

Isso não se explica sozinho. Em 11 dias produção ganhou 160 versões e o
repositório ganhou 58 — nenhuma das duas coisas reduz interseção. As causas
possíveis, nenhuma verificada:

1. a contagem de 12/09 usou método diferente do daqui (comparação do prefixo de
   14 dígitos, string exata);
2. linhas foram **removidas** de `schema_migrations` desde então;
3. arquivos foram renomeados no repositório, mudando o timestamp.

Conferido: desde 12/09 houve **uma** remoção de arquivo em
`supabase/migrations/` (`20260922110100_param_retorno_antecedencia_2.sql`), o
que não explica uma queda de 15 na interseção.

**Consequência para o Bloco B:** enquanto essa diferença não for explicada, não
se pode afirmar que a tabela de controle só cresce. Qualquer plano que assuma
"nada é removido daqui" está assumindo o que não foi demonstrado — e é
exatamente esse tipo de suposição que o item 4 do pedido da gestão proíbe.

## 3. O que "reconciliar" pode significar, e o que cada caminho custa

Não existe reconciliação que iguale 1.398 e 509. As opções reais:

### Caminho 1 — Baseline: marcar os 483 arquivos como aplicados

Inserir em `schema_migrations` uma linha por versão de arquivo ausente, **sem
executar o SQL**, para que um `db push` futuro seja no-op.

* **Ganha:** a trilha A volta a ser executável; `db push` deixa de ser uma arma.
* **Perde:** afirma "aplicada" para migration que pode nunca ter rodado. O
  próprio `DUAS-TRILHAS.md` já identificou **2** casos assim
  (`LEGACY_NAO_APLICADA_REDUNDANTE`), e não há verificação para as outras 481.
* **Risco central:** grava no banco uma afirmação que ninguém conferiu. Depois
  de feito, não há como distinguir "aplicada de verdade" de "marcada como tal".

### Caminho 2 — Remover as 1.372 versões que só existem em produção

* **Perde tudo:** essas 1.372 linhas são o **único** registro do SQL que rodou
  em produção. Removê-las apaga a história e não torna nada executável.
* **Não recomendado em nenhuma hipótese.**

### Caminho 3 — Não mexer na tabela; formalizar as duas trilhas

Manter `schema_migrations` como está, declarar `supabase/migrations/` como
documentação de intenção (não executável), e manter o ledger como prova do que
rodou — que é o estado de fato desde 12/09.

* **Ganha:** risco zero; nenhuma afirmação nova é gravada.
* **Perde:** `db push` continua proibido, e um ambiente novo continua sem
  conseguir se reproduzir a partir do repositório.

### Caminho 4 — Baseline verificada, por lotes

Como o 1, mas cada versão só é marcada depois de se provar que seu efeito já
está no banco (objeto existe, corpo confere por md5, constraint presente).

* **Ganha:** a afirmação gravada é verdadeira.
* **Perde:** 483 verificações, muitas sem critério objetivo possível
  (migration de `update` de dado não deixa marca verificável).

## 4. Os 21 timestamps duplicados

Continuam sendo o mesmo problema descrito em `DUAS-TRILHAS.md`:
`schema_migrations` tem `PRIMARY KEY (version)`, então dois arquivos com a mesma
versão nunca podem ser os dois registrados. Num `db push`, o segundo é ignorado
em silêncio ou aborta. **Nenhum dos 21 está em produção hoje** — o risco é de
replay, não de agora.

Qualquer baseline (caminhos 1 ou 4) tem de decidir o que fazer com eles
**antes**, porque marcar "aplicada" uma versão duplicada esconde permanentemente
qual dos arquivos foi considerado.

## 5. O que o Bloco A não fez

* não propôs ação — a escolha entre os caminhos é da gestão;
* não explicou a queda da interseção (seção 2);
* não verificou se as 483 versões de arquivo estão ou não refletidas no banco;
* não tocou em nada.

## Como reconferir

```sql
select count(*) total,
       count(*) filter (where version like '%0000') por_arquivo,
       count(*) filter (where statements is null) sem_statements
  from supabase_migrations.schema_migrations;
```

```bash
git ls-tree --name-only origin/main supabase/migrations/ | grep '\.sql$' \
  | sed -E 's|.*/([0-9]{14}).*|\1|' | sort -u | wc -l
```
