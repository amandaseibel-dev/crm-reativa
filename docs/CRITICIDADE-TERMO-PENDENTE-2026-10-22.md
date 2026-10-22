# Criticidade: `termo_pendente` é constante, e por isso acionar não tira ninguém de URGENTE

**22/10/2026 — medição em produção, somente leitura. Nada foi aplicado.**

Documento de apoio da migration `20261022220000_criticidade_termo_pendente_real.sql`.

---

## 1. A causa

`alunos.nivel_criticidade` sai de
`calibragem_nivel_criticidade(dias_venc, dias_sem_ac, valor, termo_pendente, fim_mes, regras)`.
O quarto argumento é montado, em dois lugares, assim:

```sql
c.status_termo is not null
  and lower(coalesce(c.termo_status_validacao,'')) not in ('validado','assinado','aprovado')
```

Só que `casos.status_termo` nunca foi outra coisa:

```sql
select count(*), count(*) filter (where status_termo is null),
       count(distinct status_termo) from public.casos;
-- 18.424 linhas | 0 nulos | 1 valor distinto: 'Sem termo'
-- e 0 linhas com termo_status_validacao em (validado, assinado, aprovado)
```

O valor que significa **"não tem termo"** é lido como **"termo pendente"**: o peso `+2` entra
em 100% dos casos, sempre. Peso constante não discrimina — ele empurra a carteira inteira um
degrau para cima e, pior, **anula exatamente o `-2` de `acionado_recente`** (≤ 7 dias), que
existe para o caso sair do radar depois do contato.

Matriz rodada na própria função do banco (vencido 30 dias, saldo R$ 6.000, fora do fim de mês):

| dias sem acionamento | hoje (termo sempre TRUE) | com o predicado corrigido |
|---|---|---|
| 0, 1, 3, 5, 7 | **URGENTE** | ATENÇÃO |
| 8 | CRÍTICO | URGENTE (escada) |
| 9 | CRÍTICO | CRÍTICO |
| 10+ | PERDENDO | PERDENDO |

É o relato da operação, por escrito: **acionar não muda a faixa**. Em produção, **1.013 dos
1.360** casos URGENTE da carteira ativa estão nessa situação — acionados nos últimos 7 dias.

O sinal de termo existe em outro lugar e **não é lido por este peso**: `termos_acordo` tem 950
linhas (a mais recente de hoje), com os status `TERMO_LIBERADO_AUTOMATICO_GOV`,
`TERMO_RECEBIDO_LIBERADO` e `TERMO_REJEITADO`. E quando um termo volta, quem marca o caso é
`sistema_retorno_termo`, que escreve `nivel_criticidade = 'URGENTE'` **direto na ficha** — o
peso não participa desse fluxo.

---

## 2. O que muda

Uma expressão, em duas funções, e nada mais:

```sql
-- de
c.status_termo is not null and lower(coalesce(c.termo_status_validacao,'')) not in (...)
-- para
upper(btrim(coalesce(c.status_termo,''))) not in ('', 'SEM TERMO')
  and lower(coalesce(c.termo_status_validacao,'')) not in (...)
```

`recalcular_situacao_aluno(uuid,text)` grava a criticidade do aluno;
`calibragem_criticidade_auto()` é o que a tela de Calibragem mostra. Corrigir só uma faria a
Calibragem e a carteira do operador discordarem.

**O peso continua +2.** Ele volta a valer de verdade no dia em que `casos.status_termo` carregar
um termo — há teste provando que um termo realmente pendente soma +2 e leva a URGENTE mesmo com
acionamento de hoje.

Medição que sustenta as três travas da migration (produção, 22/10/2026, somente leitura):

| função | md5(prosrc) antes | md5 previsto depois | chars | âncora |
|---|---|---|---|---|
| `recalcular_situacao_aluno(uuid,text)` | `eb6b5f79…47a9` | `41475103…c5a8` | 13.357 → 13.397 | 1× |
| `calibragem_criticidade_auto()` | `7850e754…5a1c` | `638d1fc4…5a86` | 2.359 → 2.399 | 1× |

Os **+40 caracteres** em cada uma são exatamente o tamanho da troca: nada além da âncora se move.

---

## 3. Impacto por faixa — a carteira do operador

Recalculado com a própria função do banco sobre os casos em `COBRANCA_VENCIDA` com operador
(nos demais estados o nível é forçado e não passa pela fórmula):

| de → para | casos | saldo total | tinham ≥ 8 dias sem acionamento |
|---|---|---|---|
| ATENÇÃO → **NORMAL** | **2.557** | R$ 5,06 mi | 0 |
| URGENTE → ATENÇÃO | **1.013** | R$ 18,73 mi | 0 |
| CRÍTICO → URGENTE | 62 | R$ 587 mil | 62 |
| PERDENDO → PERDENDO | 2.116 | R$ 5,05 mi | 2.116 |
| CRÍTICO → CRÍTICO | 249 | R$ 811 mil | 249 |
| URGENTE → URGENTE | 327 | R$ 575 mil | 327 |

**A faixa Atenção esvazia.** Hoje, dentro de `COBRANCA_VENCIDA`, a faixa Normal tem 18 casos —
porque todo mundo recebe o +2. Depois, Normal passa a ~2.580 e Atenção fica com os 1.013 (os de
saldo ≥ R$ 5.000 acionados na semana). Isso é consequência da correção, não efeito colateral: é
o que a regra sempre quis dizer.

Apareceram também **6 rótulos velhos** (1 URGENTE, 1 CRÍTICO e 4 PERDENDO com menos de 8 dias,
que a fórmula de hoje já não sustenta) — resíduo de recálculo, não da regra.

### Foco do Dia

O Foco do Dia usa `critAlta` (Perdendo/Crítico/Urgente):

* **saem ~886 casos** — os 1.013 menos 126 que têm retorno devido e 1 marcado como prioritário;
* os 2.557 que viram Normal **já estavam fora** (Atenção nunca entrou no Foco do Dia); o que
  eles perdem é o selo de criticidade na linha;
* os 62 que descem de Crítico para Urgente **continuam** no Foco do Dia.

### A garantia de que risco real continua destacado

**Nenhum caso com 8 dias ou mais sem acionamento muda de faixa para baixo.** A escada de
8/9/10 dias é piso e não é tocada. Tudo que cai foi acionado nos últimos 7 dias — e volta
sozinho para URGENTE no 8º dia. A exposição é limitada a uma semana, e a Parte B (PR separada)
já escreve na linha de onde veio cada faixa.

Há teste varrendo essa garantia: para dias ∈ {8, 9, 10, 15, 40} e valor ∈ {0, 100, 6.000,
90.000}, a faixa continua alta em todas as combinações.

---

## 4. Impacto na Calibragem da gestão

`calibragem_criticidade_auto()` calcula na hora, sem campo gravado: **a tela muda assim que a
migration aplica, sem depender de recálculo.**

| de → para | casos |
|---|---|
| ATENÇÃO → NORMAL | 1.044 |
| URGENTE → ATENÇÃO | 2 |
| PERDENDO → PERDENDO | 3.282 |
| NORMAL → NORMAL | 2.720 |
| URGENTE → URGENTE | 407 |
| CRÍTICO → CRÍTICO | 267 |

**Divergência pré-existente, encontrada no caminho e fora deste escopo:** a Calibragem usa
`casos.dias_atraso` enquanto `recalcular_situacao_aluno` calcula os dias de vencido a partir das
parcelas e títulos vivos. Por isso a Calibragem já mostra 407 URGENTE onde a carteira mostra
1.360 — as duas telas respondem a mesma pergunta com entradas diferentes, hoje, antes de
qualquer correção. Esta PR **não** mexe nisso; fica registrado para decisão.

---

## 5. Migration, rollback, recálculo e ledger

| peça | arquivo | estado |
|---|---|---|
| migration | `supabase/migrations/20261022220000_criticidade_termo_pendente_real.sql` | **não aplicada** |
| rollback | `supabase/rollbacks/20261022220000_criticidade_termo_pendente_real.rollback.sql` | pronto |
| recálculo | `supabase/aguardando_aprovacao/20261022220100_recalculo_apos_termo_pendente.sql.pendente` | **não executado** |
| testes | `supabase/tests/criticidade_termo_pendente.test.js` | 28 em Postgres real |

### Ledger

Pela regra 1 do `supabase/ledger/LEIA-ME.md`, o ledger guarda **o que rodou em produção, byte a
byte** — então a entrada só pode ser escrita **depois** de aplicar, com a versão que produção
carimbar (que costuma divergir do nome do arquivo). A linha do `INDICE.tsv` fica preparada aqui:

```
<version>	criticidade_termo_pendente_real	-	<md5>	<bytes>	<data>	ESTRUTURAL	-	CRITICIDADE: "termo pendente" passa a significar termo pendente. ESTRUTURAL, ZERO DML: um unico statement, bloco do$$ com patch ancorado em recalcular_situacao_aluno(uuid,text) e calibragem_criticidade_auto(). O DEFEITO: casos.status_termo e constante 'Sem termo' em 18.424/18.424 linhas (0 nulos, 1 valor distinto), e o predicado `status_termo is not null` lia isso como termo pendente -- +2 em 100% dos casos, anulando o -2 de acionado_recente. EFEITO: 1.013 dos 1.360 URGENTE da carteira ativa eram URGENTE so por esse peso. TRES TRAVAS pre-medidas: md5(prosrc) antes eb6b5f79a247669d50cf311c7bab47a9 e 7850e7543596aff7c00c375d3d0c5a1c; ancora 1x em cada; md5 previsto depois 41475103b8b7ad363dfdc76c4170c5a8 e 638d1fc4d234699ac395ff24f1f65a86 (+40 chars cada). NAO TOCADO: calibragem_parametros (pesos, limiares, escada 8/9/10), sistema_retorno_termo, distribuicao, fidelizacao, acionamento, financeiro. 28 testes em Postgres real. Recalculo em arquivo separado, com autorizacao propria. PR #<n>.
```

Comandos para preencher depois de aplicar:

```sql
select version, name, md5(array_to_string(statements, E'\n')) as md5_prod,
       octet_length(array_to_string(statements, E'\n')) as bytes
  from supabase_migrations.schema_migrations
 where name like '%termo_pendente%';
```

---

## 6. Riscos

1. **Deriva do corpo em produção.** Se alguém alterar qualquer uma das duas funções entre esta
   medição e a aplicação, a trava 1 aborta a transação inteira com `CORPO INESPERADO`. Falha
   fechado, por desenho — há teste provando que a migration real recusa sobre corpo diferente.
2. **Carteira mista durante horas.** A migration corrige a regra, não reescreve rótulo: cada
   caso só muda quando for recalculado (por evento ou na virada das 03:00). Medido em 22/10:
   623 casos foram recalculados por evento entre 08:55 e 19:56 UTC. É por isso que o recálculo
   existe como passo seguinte — e a tela da Parte B já avisa que a faixa muda durante o dia.
3. **A faixa Atenção esvazia** (item 3). Se a gestão quiser mais casos em destaque, os parafusos
   são de configuração (`calibragem_parametros`: `valor.min`, `acionado_recente.peso`, limiares)
   e **não** exigem migration. Esta PR não toca nenhum deles.
4. **Os limiares foram calibrados em 03/09 com o +2 já ligado em todo mundo.** Tirar o peso
   restaura o sentido literal da regra, mas pode ter sido o que a calibragem compensou sem
   saber. A decisão de banda é da gestão; a correção aqui é do mecanismo.
5. **Sem PITR.** Rollback não é restore: é reaplicar o predicado antigo (arquivo pronto) e rodar
   a varredura. Como os campos são derivados e recalculados todo dia, isso é barato e não apaga
   nada que tenha entrado depois.
6. **Alcance além da carteira.** `nivel_criticidade` alimenta também o Foco do Dia, a ordenação
   Prioridade e os painéis da gestão. A reclassificação aparece nos três no mesmo momento.

---

## 7. Recomendação de publicação

1. Mesclar esta PR (só código versionado; nada roda em produção com o merge).
2. Reconferir as duas travas em leitura, imediatamente antes de aplicar:
   `select md5(prosrc) ...` tem de devolver `eb6b5f79…` e `7850e754…`.
3. Aplicar a migration fora do horário de operação, por `apply_migration`.
4. Conferir os md5 de depois (`41475103…`, `638d1fc4…`).
5. Rodar o recálculo preparado e olhar `erros` no retorno.
6. Rodar a consulta de garantia do item 3 do arquivo de recálculo: tem de voltar **vazia**.
7. Escrever a entrada do ledger com a versão que produção carimbou.

Nenhum dos passos 2 a 7 foi executado.
