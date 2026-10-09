# Reprocessar arquivos de mensalidade — análise e simulação

**Data:** 2026-10-08 · **Modo: AUDITORIA DE CÓDIGO + DESENHO.**
Nenhuma importação executada, nenhuma migration aplicada, nenhum `UPDATE`/
`INSERT`/`DELETE` em produção, nenhum merge, nenhum commit.

**Origem declarada pela gestão em 08/10/2026:** "a ideia é reprocessar os
arquivos" · "arquivo é apenas de mensalidades, não terá acordos".

Simulação:
[`supabase/aguardando_aprovacao/20261008_SIMULACAO_reimportacao_parcelas_ausentes.sql`](../supabase/aguardando_aprovacao/20261008_SIMULACAO_reimportacao_parcelas_ausentes.sql)

Continuação de [`J3-PRESENCA-POR-EXTRACAO-2026-10-01.md`](J3-PRESENCA-POR-EXTRACAO-2026-10-01.md).

---

## ⛔ Resposta curta

**Sim, é possível identificar as parcelas ausentes com chave confiável. Não, não
dá para reprocessar os arquivos pelo caminho que existe hoje** — a tela de
Borderôs faz `upsert` e **reativa título `NEGOCIADO`**, que é exatamente o que
você proibiu. Não há trava contra isso **em nenhuma das duas camadas**: nem na
tela, nem no banco.

O resto deste documento prova as duas metades e propõe o caminho que não tem esse
defeito.

---

## 1. O que não pôde ser medido, e por quê

**Não há quantidade nem valor medido aqui.** Três bloqueios, todos verificados
nesta sessão:

| Bloqueio | Evidência |
|---|---|
| **Sem leitura de produção** | O MCP do Supabase desta sessão só vê `qcwluwnljtwjhsyaysid` (INACTIVE, org `nmeqsavkiasrftrrbigp`). Produção é `ahattpqrjmhkzsmnbdzs` (org `djadacgcrxjubjblrlos`). Sem `supabase` CLI, sem `psql`, sem `service_role` em disco. Testei a chave anon no REST de produção: `42501 permission denied` nas 8 tabelas — `anon` não tem `SELECT`, só `authenticated`. Autenticar com senha é ação que não executo. |
| **Arquivos não estão nesta máquina** | Nenhum `.xls`/`.xlsx` de relatório de títulos em `~/Downloads`, `~/Desktop` ou `~/Documents`. Consistente com o J3 §H: "Arquivos `.xls` no Storage: **0 objetos** em todos os 11 buckets". |
| **Schema inicial não é versionado** | `acordos_titulos` e `parcelas` não têm `CREATE TABLE` em `supabase/migrations/` (974 arquivos). Por isso a simulação abre com um **BLOCO 0 de pré-voo** que confere as 29 colunas usadas contra `information_schema`. |

Toda cifra abaixo é **medição anterior do projeto, com data** — não desta sessão.
O que entrego é: os critérios, a simulação que produz os números, os riscos e a
proposta.

---

## 2. A tela de Acordos não processa este arquivo

Um arquivo só de mensalidade **não passa** por `ImportacaoAcordos.jsx`:

| Linha | O que faz |
|---|---|
| [125](../src/pages/ImportacaoAcordos.jsx#L125) | `if (tipo.toLowerCase() !== "acordo") continue;` — descarta toda linha de mensalidade do fluxo financeiro |
| [143](../src/pages/ImportacaoAcordos.jsx#L143) | `if (out.length === 0)` → `setErro("Nenhuma parcela de Acordo encontrada…")` e `return` |

Como o `return` acontece antes de `setLinhas(out)`, `linhas` fica `null` e
`importar()` sai na primeira linha (`if (!linhas) return`). **Nem a trilha de
presença J3/I1 é gravada**, porque a presença só é escrita dentro de `importar()`.

**Consequência:** o caminho da mensalidade é o **borderô**
([`Borderos.jsx`](../src/pages/Borderos.jsx)) — e é lá que está o problema.

---

## 3. O que um reprocesso cego faria — lido no código em vigor

### 3.1 O borderô sobrescreve, não insere

[`Borderos.jsx:409-419`](../src/pages/Borderos.jsx#L409):

```js
registrosTitulos.push({
  aluno_id, cpf, documento: linha.numTitulo, vencimento,
  valor_original: linha.valor,
  saldo_corrigido: linha.valor,
  situacao: "ABERTO",          // ← grava ABERTO, sempre
  tipo_boleto: linha.curso,
  importacao_id: importacao.id,
});
…
upsertEmLotes("acordos_titulos", registrosTitulos, "documento")   // ON CONFLICT (documento) DO UPDATE
```

Não é `insert … where not exists` (o que `importar_acordos` faz). É **upsert por
`documento`**: para todo título que já existe e não foi pulado, sobrescreve
`situacao`, `valor_original`, `saldo_corrigido`, `vencimento`, `tipo_boleto`,
`aluno_id` e `importacao_id`.

`status` **não** está no payload, então não é tocado pelo upsert — o que produz o
estado incoerente do §3.4.

### 3.2 A trava da tela cobre três situações. `NEGOCIADO` não é uma delas

[`src/utils/bordero.js`](../src/utils/bordero.js):

```js
export const SITUACOES_QUE_NAO_REABREM = Object.freeze(["PAGO", "EM_CONFIRMACAO", "CANCELADA"]);
```

[`Borderos.jsx:391`](../src/pages/Borderos.jsx#L391):
`if (linha.jaExiste && naoReabreNoBordero(linha.situacaoAtual)) continue;`

**Tudo que não está nessas três é gravado como `ABERTO`.** Inclui `NEGOCIADO`,
`VENCIDA` e qualquer outro valor.

### 3.3 O banco também não protege `NEGOCIADO`

Há três gatilhos de proteção em `acordos_titulos`. Li a condição de cada um:

| Gatilho | Dispara quando | Cobre `NEGOCIADO`? |
|---|---|---|
| `trg_titulo_em_confirmacao_protegido` ([20260918150000](../supabase/migrations/20260918150000_grupo_a_confirmacao_prime.sql)) | `old.situacao = 'EM_CONFIRMACAO'` → reverte `situacao`/`status` para o antigo | **não** |
| `trg_titulo_encerrado_administrativo_protegido` ([20260919160000](../supabase/migrations/20260919160000_prime_conferencia_encerramento_administrativo.sql)) | `old.origem_encerramento is not null` → coage para `CANCELADA`/`cancelada` | **não** |
| `trg_titulo_liquidado_na_origem_e_terminal` ([20260915120000](../supabase/migrations/20260915120000_titulo_liquidado_na_origem.sql)) | `old.origem_liquidacao = 'PRIME_LIQUIDACAO_OFICIAL'` → coage para `PAGO`/`quitada` | **não** |

> **`NEGOCIADO` → `ABERTO` não é barrado pela tela nem pelo banco.**
>
> E note a assimetria: `PAGO` e `CANCELADA` **sem** `origem_liquidacao`/
> `origem_encerramento` são protegidos **só pela tela**. Qualquer outro caminho de
> escrita (RPC, script, SQL Editor) os reabre sem resistência.

### 3.4 E há um quarto gatilho que *completa* o dano

`trg_titulo_normaliza_vinculo_incoerente`
([20260825230000](../supabase/migrations/20260825230000_trava_vinculada_sem_vinculo_e_baixa_no_historico.sql)):

```sql
if lower(coalesce(NEW.status,'')) = 'vinculada'
   and upper(coalesce(NEW.situacao,'')) = 'ABERTO'
   and NEW.acordo_id is null
   and not exists (select 1 from … v where v.titulo_id = NEW.id and coalesce(v.ativo,true))
then NEW.status := 'em_aberto';
```

O upsert deixa `status = 'vinculada'` e põe `situacao = 'ABERTO'`. Então:

- **sem vínculo ativo** → este gatilho zera o `status` para `em_aberto`. O título
  fica `ABERTO/em_aberto`: **a negociação desaparece por completo**;
- **com vínculo ativo** → fica `ABERTO/vinculada`, um estado incoerente. A fórmula
  canônica conta título como cobrável quando `situacao ∈ (ABERTO, NEGOCIADO)` e
  `status ≠ 'quitada'` ([`REGRA-SALDO-COBRAVEL.md`](REGRA-SALDO-COBRAVEL.md) §2),
  e as parcelas do acordo também somam — **risco de dobra de dívida**, o erro que
  o [mapa de identificadores](integracoes/prime-mapa-identificadores.md) registra
  como já ocorrido no re-acordo.

O efeito exato no saldo depende do vínculo título a título. **O BLOCO B da
simulação entrega o `delta` medido**; eu não tenho como medi-lo aqui.

### 3.5 O borderô ainda reativa aluno quitado e reabre parcela de quitação manual

[`Borderos.jsx:445-530`](../src/pages/Borderos.jsx#L445) — para todo aluno com
título gravado no lote e `status_jornada ∈ (QUITADO, QUITADO_MANUAL)`:

1. `status_jornada`, `status_atual`, `status_acionamento`, `proxima_acao` := `CONTATAR`;
2. títulos `status='quitada'` com `motivo_ajuste ilike '%quitado manualmente%'`
   voltam a `ABERTO`/`em_aberto` com `saldo_corrigido := valor_original`;
3. parcelas `PAGO` com `pago_em IS NULL` voltam a `A_VENCER`, e o acordo `QUITADO`
   é **reativado** se sobrar saldo.

**Isto não é opcional nem configurável: roda sempre que o lote toca um aluno
quitado.** É o oposto da garantia pedida ("não reative parcelas … quitadas …
encerradas") e também mexe em `status_atual`, que é fila operacional.

A simulação mede essa população no **BLOCO B2**.

### 3.6 Provência perdida

O upsert grava `importacao_id` da importação corrente. J3 §A.2 já registrou:
`importacao_id` passa a ser **a última importação que tocou o título, não a
primeira**. Reprocessar arquivos antigos reescreve a origem de títulos cuja
origem hoje está correta — e `ORIGEM_MENSURAVEL`
([`REGRA-SALDO-COBRAVEL.md`](REGRA-SALDO-COBRAVEL.md) §5) depende dela.

---

## 4. Critérios de identificação

### 4.1 A chave única da origem — já provada

| Chave | Onde vive | Prova (01/10/2026) |
|---|---|---|
| `acordos_titulos.documento` | título, **inclusive mensalidade** | 47.949 distintos em 47.949 (100%), 0 vazio, 0 duplicado, 0 documento em dois alunos; `acordos_titulos_documento_key` UNIQUE já existe |
| `parcelas.boleto` | parcela de acordo | 13.826 distintos em 13.826; índice `ux_parcelas_boleto` |
| forma canônica | ambas | `extracao_documento_norm()` = `nullif(ltrim(doc,'0'),'')` — **medido: não colide em nenhuma das duas** |

**Precedência fixa, com motivo medido:** 377 chaves existem nas duas tabelas;
**376 apontam para o mesmo aluno e 1 divergia**. Título primeiro, parcela só como
fallback — a mesma precedência que a trilha J3 já usa.

### 4.2 Onde a chave **não** é confiável

Taxonomia de `documento` medida em 01/10 (J3 §B.1), total 47.949:

| Dígitos | Qtd | Natureza | Risco no reprocesso |
|---:|---:|---|---|
| 6 | 9.833 | boleto legado (carga inicial 02–06/07) | formato abandonado; casar por ele é frágil |
| 7 | 37.632 | **boleto ULBRA corrente** | é o formato da mensalidade — o caso bom |
| 12 | 381 | boleto de **acordo** | não deveria aparecer num arquivo de mensalidade; trava no BLOCO D |
| 13 | 23 | formato alternativo | conferência humana |
| 20 / 68–70 | 15 / 65 | `MANUAL-*` gerado pelo CRM | **80 títulos nunca aparecem em arquivo nenhum.** 100% viram falso positivo se não excluídos |

Mais um, fora da chave mas na mesma classe de risco: **mojibake real em
`tipo_boleto`** ("Cursos de GraduaÁ„o Presencial", 1.124 títulos; "Extens„o", 4).
O mesmo curso gravado de dois jeitos.

### 4.3 Os quatro grupos, com precedência declarada

`DIVERGENTE > PROTEGIDA > JA_EXISTENTE > AUSENTE_ELEGIVEL`

Divergente primeiro **de propósito**: o que não se identifica com segurança não
pode ser classificado como elegível.

| Grupo | Critério |
|---|---|
| **1 JA_EXISTENTE** | chave casa, título vivo (`ABERTO`). Reprocesso só sobrescreveria o valor |
| **2 PROTEGIDA** | P1 liquidado na origem · P2 encerrado administrativo · P3 em Conferência Prime · P4 `PAGO`/`CANCELADA` · P5 `status='quitada'` · **P6 `NEGOCIADO` — sem trava** · P7 parcela terminal · P8 caso quitado/encerrado/cancelado/`nao_acionar` · P9 aluno em jurídico/suspensão/cancelamento/quitado |
| **3 AUSENTE_ELEGIVEL** | ausente nas duas tabelas, chave numérica confiável, CPF presente, nenhuma proteção |
| **4 DIVERGENTE** | D1 fora de `^[0-9]{6,13}$` (inclui `MANUAL-*`) · D2 dois alunos para a mesma chave · D3 legado 6 dígitos · D4 alternativo 13 dígitos · D5 ausente **e sem CPF** (não dá para resolver o aluno) |

A simulação rotula P6 explicitamente como `*** SEM TRAVA NENHUMA ***` para que a
decisão não dependa de alguém lembrar deste documento.

---

## 5. Riscos

| # | Risco | Gravidade | Mitigação |
|---|---|---|---|
| 1 | **`NEGOCIADO` → `ABERTO` sem trava** (§3.2, §3.3) | **Crítica** — desfaz negociação e arrisca dobra de dívida | não usar a tela de Borderôs; gatilho de banco (§6.1) |
| 2 | **Aluno quitado volta para `CONTATAR`; parcela de quitação manual reabre; acordo `QUITADO` reativa** (§3.5) | **Crítica** — e roda sempre, não é opcional | caminho novo que não executa esse bloco |
| 3 | **`PAGO`/`CANCELADA` protegidos só na tela** (§3.3) | **Alta** — qualquer outra escrita os reabre | gatilho de banco (§6.1) |
| 4 | **`importacao_id` sobrescrito** → provência perdida (§3.6) | Alta | não tocar `importacao_id` de título existente |
| 5 | **80 chaves `MANUAL-*`** nunca aparecem em arquivo | Média — 100% falso positivo se não excluídas | grupo D1 |
| 6 | **9.833 boletos de 6 dígitos** e 23 de 13 | Média — taxonomia mista na mesma coluna | grupos D3/D4 |
| 7 | **1 chave em 377** aponta para dois alunos | Média — vínculo financeiro errado | precedência fixa; grupo D2 |
| 8 | **Linha sem CPF** não resolve aluno; nome **nunca** vincula (10 baixas erradas em 08/09) | Média | grupo D5 — fica fora do elegível por construção |
| 9 | **`aluno_id` sobrescrito pelo upsert** se o CPF do arquivo resolver outro aluno | Média | caminho novo não atualiza `aluno_id` de título existente |
| 10 | **Mojibake em `tipo_boleto`** (1.124 títulos) | Baixa | `extracao_rotulo` normaliza por id |
| 11 | `substr(documento,4,5)` decodifica acordo em 5 dígitos; documentado é 6 (PREMISSAS 19) | Baixa **aqui** (arquivo sem acordo), latente no geral | trava no BLOCO D mede a margem |

---

## 6. O que foi construído — pronto, **nada aplicado**

Quatro artefatos. Nenhuma migration aplicada, nenhum dado importado, nenhum
merge, nenhum commit.

### 6.1 Proteção no banco — `supabase/aguardando_aprovacao/20261008120000_protecao_importacao_nao_reativa.sql.pendente`

| Objeto | O que faz |
|---|---|
| `ux_acordos_titulos_documento_norm` | índice **único** sobre `extracao_documento_norm(documento)`. Fecha a brecha do zero à esquerda: hoje `04039712` e `4039712` são chaves diferentes para o banco, mas o importador casa por `ltrim`. Torna a repetição segura no banco, não só no `WHERE` da aplicação |
| `_titulo_importacao_nao_reativa()` + `trg_titulo_importacao_nao_reativa` | `BEFORE UPDATE`: quando a escrita é de importação, a `UPDATE` vira **no-op completa** (`new := old`) — valor, vencimento, dono, status e `importacao_id` ficam como estavam. Quando o estado era protegido, grava `TITULO_IMPORTACAO_REATIVACAO_RECUSADA` em `auditoria` com o motivo |
| `mensalidades_ausentes_inserir(jsonb, text, boolean)` | RPC **insert-only**, `p_dry_run = true` por default |

**O ponto de desenho que importa: como a trava reconhece "importação" sem cegar
o que é legítimo.** `NEGOCIADO → ABERTO` é caminho legítimo em produção —
`titulo_reavaliar` devolve a mensalidade quando o acordo é cancelado sem
pagamento na cadeia (migration `20260925123852`). Uma trava terminal genérica
mataria essa regra.

Também descartei a polaridade `v_oficial` dos três gatilhos existentes (GUC que o
chamador legítimo acende): exigiria uma allowlist de 17+ funções que escrevem a
tabela, e esquecer uma quebra produção em silêncio.

A trava identifica o importador por **duas marcas**, e é inerte fora delas:

1. **`reativa.importando = 'on'`** — GUC transacional que `importar_acordos` **já
   acende hoje** (`20260917200000`) e que a RPC nova também acende. Forjável?
   Sim — e inofensivo: acender essa chave só deixa a proteção **mais** restritiva
   para quem a acendeu. Não há ganho em forjar. (Por isso aqui não é preciso o
   `pg_context` da memória `porta-de-maquina-guc-mais-pilha`: aquele padrão existe
   para *allowlist*, onde forjar afrouxa.)
2. **a `UPDATE` reescreve `importacao_id` de título que já existe.** Medido em
   08/10/2026: **zero** ocorrência de atualização de `importacao_id` em 974
   migrations e em `src/`. O único caminho que faz isso é o `upsert` do borderô.
   Esta marca pega o importador **mesmo se a correção da tela for revertida.**

Estados protegidos, traduzindo o que você nomeou para o schema: `situacao ∈
(NEGOCIADO, PAGO, QUITADO, QUITADA, CANCELADA, CANCELADO, EM_CONFIRMACAO,
DEVOLVIDA, DEVOLVIDO)`; `status ∈ (quitada, cancelada, devolvida)`;
`origem_liquidacao` ou `origem_encerramento` preenchidos; **e, para "incluindo
acordos e vínculos financeiros", `acordo_id` não nulo ou vínculo ativo em
`acordo_titulo_vinculo`.** "Suspensa" não é estado de título — vive em
`alunos.status_*` e é barrada na RPC, não no gatilho.

Coage em vez de abortar, igual a `trg_titulo_liquidado_na_origem_e_terminal`: uma
linha protegida não derruba o lote inteiro.

Fecha com um bloco **PROVA** que aborta a migration se o gatilho ou o índice não
nascerem, se um dos três gatilhos preexistentes tiver desaparecido, se `anon`
tiver ganhado `EXECUTE`, ou se a própria migration disparar a trava. Rollback
determinístico por objeto nomeado em
`20261008120000_protecao_importacao_nao_reativa.rollback.sql` (PITR não está
habilitado — rollback nunca é restore).

### 6.2 Importador de borderôs — 6 alterações mínimas

| Arquivo | Alteração |
|---|---|
| [`src/utils/bordero.js`](src/utils/bordero.js) | `SITUACOES_QUE_NAO_REABREM` ganhou **`NEGOCIADO`**, `CANCELADO`, `QUITADO`, `QUITADA`, `DEVOLVIDA`, `DEVOLVIDO`; novo `STATUS_QUE_NAO_REABREM` (`quitada`, `cancelada`, `devolvida`), porque a base tem título `VENCIDA`/`quitada` e conferir só `situacao` deixava passar linha liquidada; novo `motivoDeNaoTocar()` |
| [`Borderos.jsx`](src/pages/Borderos.jsx) | `upsertEmLotes` → `inserirIgnorandoExistentesEmLotes` (`ignoreDuplicates: true` ⇒ `ON CONFLICT DO NOTHING`). **Nenhum título existente é tocado** |
| | o `select` passou a trazer `status` junto de `situacao` |
| | o filtro virou `motivoDeNaoTocar(linha)`: ignora **todo** título já existente, não só os terminais |
| | `inseridos = registrosTitulos.length`, `atualizados = 0` por construção |
| | bloco de reativação **separado em dois** (ver abaixo) |

**A separação do bloco de reativação, que eu quase errei.** Minha primeira versão
desligou o bloco inteiro. O teste `ajusteValorNasTelas` me mostrou que a
interface promete ao operador, em dois lugares, *"Só volta se subir um título novo
dele em algum borderô"* — desligar tudo faria a tela mentir. O bloco fazia três
coisas, e só uma é fila:

| | O que fazia | Decisão |
|---|---|---|
| 1 | aluno sai de `QUITADO`/`QUITADO_MANUAL` e volta para `CONTATAR` | **MANTIDO** — é promessa do produto, e com o importador insert-only agora só dispara quando entra título **realmente novo** |
| 2 | restaura o saldo de títulos `quitada` com motivo "quitado manualmente" | **DESLIGADO** |
| 3 | parcela `PAGO` sem data volta para `A_VENCER` e o acordo `QUITADO` é **reativado** | **DESLIGADO** |

2 e 3 são literalmente o que você proibiu. Ficam no código atrás de
`RESTAURAR_QUITACAO_NO_BORDERO = false`, não apagados: religar é decisão de
negócio.

> **Consequência que você precisa saber:** reimportar um borderô deixa de corrigir
> valor/vencimento de título que já existe. Era o único efeito útil do `upsert` —
> e era o mesmo mecanismo que reabria `NEGOCIADO`. Ajuste de valor de título
> existente continua possível pela ficha, que tem trilha própria em
> `titulo_valor_ajuste_historico`.

### 6.3 Testes direcionados — `src/utils/bordero.test.js`, 13 testes verdes

Seguem o padrão de `preventivo.test.js`: carregam a **migration pendente de
verdade** em PGlite, não uma cópia do SQL — se a migration mudar, o teste
acompanha.

As duas direções que decidem se a trava está certa:

| Teste | Prova |
|---|---|
| `NEGOCIADO sobrevive à assinatura do borderô` | o `UPDATE` que o `upsert` fazia deixa `situacao`, `status`, saldo **e `importacao_id`** intactos, e grava `motivo = situacao=NEGOCIADO`, `marca = importacao_id` |
| `título ABERTO existente não é atualizado` | no-op com a GUC acesa, sem poluir a auditoria |
| `vínculo financeiro ativo protege` | `VENCIDA` com vínculo ativo é protegida mesmo sem situação terminal |
| **`titulo_reavaliar CONTINUA devolvendo NEGOCIADO → ABERTO`** | **a trava é inerte fora das duas marcas.** É o teste que impede alguém "endurecer" a proteção até quebrar a regra de 25/09 que está em produção |
| `a RPC insere só o ausente, é idempotente e não cria aluno` | dry-run grava 0; a segunda execução insere 0; nenhum aluno criado |
| `o índice normalizado recusa zero à esquerda` | `04039712` colide com `4039712` |

**O teste achou um defeito real meu antes de você ver:** eu testava existência por
`t.aluno_id is not null`, mas um título pode existir com `aluno_id` nulo — a RPC
classificaria título presente como ausente e **inseriria duplicata**. Corrigido
para testar pela chave que casou (`t.k is not null`), na RPC e na simulação.

### 6.4 Simulação — `20261008_SIMULACAO_reimportacao_parcelas_ausentes.sql`

Quatro grupos com quantidade e valor (`GROUPING SETS` entrega total do grupo e
detalhe por motivo e curso numa passada), censo de confiabilidade da chave, 8
travas, e a foto antes/depois com digest md5.

E o **BLOCO B**, que mede o dano de um reprocesso cego **antes** de ele acontecer:
reproduz a decisão exata de `Borderos.jsx` e separa em `a) pulado pela tela`,
`b) tela grava, banco reverte`, `c) só o valor é sobrescrito`,
`d) NEGOCIADO → ABERTO: REATIVADO`, `e) <outra> → ABERTO: REATIVADO`, com
`saldo_hoje`, `saldo_depois` e `delta`. O **BLOCO B2** conta alunos que sairiam de
quitado, títulos que teriam saldo restaurado e parcelas que voltariam para
`A_VENCER`.

Validada em PGlite com fixture de 12 linhas: **7 statements, 0 falhas**, cada
linha no grupo previsto e cada efeito do §3 reproduzido. A validação achou e
corrigiu três defeitos meus (um `GROUP BY` por ordinal, uma referência de coluna
fora de escopo, e `saldo_depois` mostrando o valor do arquivo em linha que a tela
pula). Harness em `.validar-sim.mjs` (não rastreado, padrão do
`.validar-acordo.mjs` que já existia).

### 6.5 O que rodou

| Verificação | Resultado |
|---|---|
| `bordero.test.js` | **13 testes verdes** |
| `eslint` nos 3 arquivos alterados | limpo |
| `npm run build` | sucesso |
| `npm run check:migrations` | `✓ nada piorou` (base `origin/main` 2b55c2dc) |
| simulação em PGlite | 7 statements, 0 falhas |

**Falhas que NÃO são minhas:** `ajusteValorNasTelas.test.js` tem 9 testes
vermelhos, nomeando `Aluno.jsx`, `PainelCarteira.jsx`, `CRM.jsx`,
`FilaOperacional.jsx` e `FinanceiroAluno.jsx` — arquivos que eu não toquei. Esse
arquivo de teste **não está no `HEAD`**: é do trabalho já pendente nesta árvore,
anterior a esta sessão. As asserções dele sobre `Borderos.jsx` passam. Os
vermelhos em `.claude/worktrees/` são a cópia do worktree, que o CI não enxerga.

---

## 7. Ordem recomendada

1. **Aplicar §6.1** (proteção no banco). Vale por si, mesmo que a inclusão nunca
   aconteça: hoje `NEGOCIADO` não tem trava em camada nenhuma, e `PAGO`/`CANCELADA`
   só têm no navegador.
2. **Mesclar §6.2** (importador). Sozinha já elimina a reativação por construção.
3. **Rodar a simulação** com o arquivo carregado na `TEMP TABLE`. Ler o BLOCO B e
   o B2 — eles dizem em título e em reais o que o caminho antigo faria.
4. **`mensalidades_ausentes_inserir` em `p_dry_run = true`** e conferir se os
   quatro números batem com o BLOCO A da simulação. São códigos independentes
   lendo a mesma regra: divergência entre eles é sinal de erro, não de ruído.
5. Lote canário pequeno com `p_dry_run = false`, com a foto do BLOCO E antes e
   depois.

---

## 8. O que falta para concluir

| # | Falta | Quem |
|---|---|---|
| 1 | **Sua autorização** para aplicar a migration e mesclar o importador. Nada foi aplicado, importado ou mesclado. | você |
| 2 | **Os arquivos de mensalidade** — quantos, de que período, onde. Qualquer um anterior a 01/10/2026 é a única cópia existente (Storage tem 0 objetos `.xls`). | você |
| 3 | **Rodar a simulação e o `p_dry_run`**: você no SQL Editor, ou leitura de produção para mim. Sem isso não há quantidade nem valor — e sem o BLOCO 0 (pré-voo) eu não consigo confirmar 3 colunas que só aparecem em migrations, porque o schema inicial não é versionado: `alunos.status_acionamento`, `casos.cancelado_em`, `acordos_titulos.valor_cobranca_ajustado`. | ambos |
| 4 | **Decisão:** a RPC hoje **não cria aluno**. Linha cujo CPF não resolve aluno existente cai em `DIVERGENTE` e não entra. O borderô criava aluno novo. Se você quiser que a inclusão crie a ficha, é mudança de escopo e eu preciso do seu OK. | você |
| 5 | **Decisão:** `RESTAURAR_QUITACAO_NO_BORDERO` ficou `false`. Se algum dia a quitação manual precisar ser desfeita por reimportação, religar é decisão sua — hoje o caminho correto é a ficha. | você |
| 6 | **Ledger** das duas versões, se a migration for aplicada (convenção do projeto: versão que já existe na base ganha linha no `INDICE.tsv` com arquivo `-`, nunca cópia). | eu, depois do OK |
