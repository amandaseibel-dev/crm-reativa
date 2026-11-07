# Simulação executada e três achados — retenção das importações

**Data:** 07/11/2026 · **Ambiente:** PRODUÇÃO `ahattpqrjmhkzsmnbdzs`
**Natureza:** SOMENTE LEITURA. Nada excluído, nada reprocessado, nenhum status
alterado, nenhuma migration, nenhuma rotina automática.

Complementa [DIAGNOSTICO-RETENCAO-IMPORTACOES-2026-11-07.md](DIAGNOSTICO-RETENCAO-IMPORTACOES-2026-11-07.md)
e executa [simulacao-retencao-importacoes.sql](simulacao-retencao-importacoes.sql).

---

## 0. Como a contagem foi obtida — e por que não se repete

**Registro honesto da ordem dos fatos.** A contagem exata com `count(*)` nas 548
relações (bloco 4 do SQL) **foi executada em 07/11/2026**, numa passada única,
**antes** de a gestão decidir que não se conta linha nesta etapa. Terminou sem
sinal de impacto e o resultado está na seção 1.

A decisão posterior da gestão é: **não contar linha**. Para saber se uma relação
está vazia, o caminho sancionado é `exists (select 1 … limit 1)`, **uma consulta
por vez**, com `set local statement_timeout` dentro de transação e
**confirmado por `show statement_timeout`** — porque `statement_timeout` em
`proconfig` **não rearma**, armadilha já paga neste projeto —, e com **parada ao
primeiro sinal de impacto**, valendo resultado parcial com o ponto de parada
declarado.

Esse caminho está **preparado** no **bloco 4-SEQ** de
[simulacao-retencao-importacoes.sql](simulacao-retencao-importacoes.sql), em 4
passos: gerar a lista na ordem, gerar os comandos um por relação (texto para
colar, deliberadamente **não** um loop — loop volta a ser varredura), o modelo de
uma verificação com a conferência do timeout, e a regra de parada com medição de
`pg_stat_activity` a cada ~50 relações.

**O bloco 4-SEQ não foi executado, e não precisa ser:** o número que ele
produziria já existe. Rodá-lo agora seria carga nova para reobter dado que está
na seção 1. O bloco 4 original ficou no arquivo **comentado**, como registro do
que rodou, marcado para nunca mais rodar.

---

## 1. Simulação executada — `_backup_pos_import_*`

### Contagem exata (bloco 4, execução única de 07/11/2026)

| | Tabelas | Linhas | Tamanho |
|---|---|---|---|
| **Comprovadamente VAZIAS** | **213** | 0 | **1.704 kB** |
| **COM conteúdo** | **335** | **11.645** | **7.912 kB** |
| Total | 548 | 11.645 | 9.616 kB |

Intervalo das que têm conteúdo: `_backup_pos_import_20260831` a
`_backup_pos_import_20260924174025`.

> **Isto corrige a expectativa do diagnóstico.** `reltuples` sugeria tabelas
> vazias; a contagem exata mostra que **61% têm linha**. Só 213 são
> comprovadamente vazias. A 1ª leva é bem menor do que parecia.

### Dependências: nenhuma

| Verificação | Resultado |
|---|---|
| FK apontando **para** elas | **0** |
| FK saindo **delas** | **0** |
| Constraints de qualquer tipo | **0** |
| Índices | **0** |
| Triggers não-internos | **0** |
| Views / matviews que as citam | **0** |
| Funções que as **leem** | **0** (só `acordos_pos_importacao`, que as **cria**) |

**Nenhum objeto do schema depende dessas 548 tabelas.** Tecnicamente, remover
qualquer uma não quebra nada no banco.

### Mas há um porém de segurança — e é o achado mais sério desta rodada

| Verificação | Resultado |
|---|---|
| RLS habilitado | **548 de 548** |
| Policies RLS existentes | **0** |
| Grants a `anon` | 0 |
| Grants a `authenticated` | **3.815** — `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` |

RLS ligado sem policy bloqueia leitura e escrita linha a linha. **`TRUNCATE` não
passa por RLS** — é governado só pelo privilégio. Portanto **qualquer token
`authenticated` pode `TRUNCATE` as 548 tabelas**, inclusive as 335 que guardam
as 11.645 linhas de lastro de desfazer de ação financeira.

Isto é o padrão já conhecido do projeto: tabela criada por `create table as`
herda `TRUNCATE` para `authenticated`. Vale **independente** da decisão de
retenção: ou o lastro importa — e então precisa de `revoke` —, ou não importa, e
então a discussão de retenção é sobre 9,6 MB.

### O que isso faz com as levas propostas

| Leva | Antes | Agora |
|---|---|---|
| 1ª — vazias | "a maioria" | **213 tabelas, 1.704 kB** |
| 2ª — com conteúdo | "o resto" | **335 tabelas, 7.912 kB, 11.645 linhas de lastro financeiro** |

**Benefício esperado da 1ª leva:** recupera **1.704 kB** (0,06% do banco) e
remove **213 dos 1.468 objetos** de `public` (−14,5% de relações). O ganho é de
catálogo, não de espaço — e segue **não comprovado** em desempenho.

**Recomendação:** a 1ª leva não se justifica por espaço. Se for feita, que seja
pelo número de objetos, e **só depois** do `revoke` de `TRUNCATE`, porque
proteger 335 tabelas de lastro vale mais que apagar 213 vazias.

---

## 2. A importação travada em `PROCESSANDO`

### Identificação

| Campo | Valor |
|---|---|
| `id` | `bff088bd-3fb3-4374-9853-a611046f2d81` |
| `tipo` / `referencia` | `BORDERO` / **333** |
| `arquivo_nome` | `Borderô 333.xls` |
| `usuario` | `amanda.seibel@aelbra.com.br` |
| `qtd_registros` | 646 |
| `created_at` | **02/07/2026 00:51:24** |
| Idade | **128 dias** |
| `excluido_*`, `substituido_*`, `reprocessado_*`, `observacao` | todos `null` |

### Ainda está ativa?

**Não.** Não há processo rodando: a linha é de 02/07, nenhum campo de
substituição/exclusão/reprocesso foi preenchido, e o fluxo do borderô é
síncrono na tela — não há job retomando. É um **status órfão**: a tela caiu ou
foi fechada entre o `insert` em `importacoes` e o `update` final para
`CONCLUIDO`.

### Houve gravação parcial?

**Sim, e é maior do que a primeira leitura indicou.** Varri **todas as 12 tabelas
que têm coluna `importacao_id`**, não só as duas óbvias:

| Tabela com `importacao_id` | Linhas da travada |
|---|---|
| **`acordos_titulos`** | **472** |
| **`importacoes_acordos`** | **1** (linha de contadores) |
| `pagamentos` | 0 |
| `borderos` | 0 |
| `acordos_revisao_parcelas` | 0 |
| `fila_acordos_confirmar` | 0 |
| `fila_pagamento_sem_vinculo` | 0 |
| `pagamento_suspeita_duplicidade` | 0 |
| `fechamento_remuneracao_pagamento` | 0 |
| `projecao_snapshot_pagamentos` | 0 |
| `importacao_acordo_critica` | 0 |
| `extracao_escopo` | 0 |

**Nenhum pagamento foi afetado** — `pagamentos` tem 0 linhas dessa importação.

#### O que a linha de contadores revela

`importacoes_acordos` tem **uma linha** para essa importação de borderô, gravada
em `2026-07-02 00:51:24.655` — **274 ms depois** da linha em `importacoes`
(`00:51:24.381`). Conteúdo:

| Campo | Valor |
|---|---|
| `parcelas` | **472** |
| `acordos` | **471** |
| `cpfs` | **471** |
| `total` | **R$ 620.870,89** |
| `arquivo_nome`, `arquivo_path`, `arquivo_sha256`, `arquivo_bytes`, `linhas_arquivo`, `importado_por`, `titulos_inseridos`, `alunos_novos` | **todos `null`** |

Dois fatos saem daí:

1. **A importação foi longe.** Não parou no `insert` inicial: gravou títulos e
   fechou contadores, inclusive o valor total. O que não aconteceu foi o `update`
   final de `status` para `CONCLUIDO`.
2. **Essa importação não tem identidade de arquivo nenhuma** — nem nome, nem
   hash, nem tamanho. É de 02/07, muito antes de o hash passar a ser obrigatório.
   Para ela, não há como provar qual planilha entrou.

#### Conferência em dinheiro, direto nos títulos

Somando os 472 títulos de `acordos_titulos` com esse `importacao_id`:

| Medida | Valor |
|---|---|
| Títulos | **472** |
| Alunos distintos | **471** |
| Valor original | **R$ 620.870,89** ← bate **exatamente** com o `total` da trilha |
| Saldo hoje | **R$ 617.124,98** |
| Saldo ainda em aberto | **R$ 565.966,54** |
| Vencimentos | 05/03/2025 a 13/03/2025 |

Situação dos 472 títulos **hoje**:

| Situação | Qtd |
|---|---|
| `ABERTO` | 457 |
| `CANCELADA` | 5 |
| `PAGO` | 5 |
| `NEGOCIADO` | 3 |
| `DUPLICADA` | 1 |
| `EM_CONFIRMACAO` | 1 |

**Esses títulos são dívida viva, em operação** — R$ 565.966,54 ainda em aberto,
5 pagos, 3 negociados, 1 em confirmação. Não são resíduo de importação falha:
são carteira, e estão sendo cobrados.

#### O que ficou pela metade, em uma frase

Ficou **o status**, não o dado: 472 títulos, 471 acordos e R$ 620.870,89 entraram
e estão corretos; o que não entrou foi a marca de que a importação terminou.

#### Os 471 acordos — atribuição não comprovável

`acordos` e `parcelas` **não têm coluna `importacao_id`**. A quantidade de acordos
criados (**471**) vem da linha de contadores, e é confiável como número. Mas
**quais** linhas de `acordos` são aquelas **não é provável por coluna** — só por
proximidade de timestamp, e neste projeto *timestamp igual não prova causa*.
Portanto: **471 é o número; a identificação linha a linha fica NÃO COMPROVADA.**

### Qual recuperação é possível

O borderô **já foi recuperado**, por reimportação:

| Importação do borderô 333 | Data | Registros | Títulos gravados |
|---|---|---|---|
| `bff088bd…` (travada) | 02/07/2026 | 646 | **472** |
| `40ad5a2b-a7a8-46a6-9e86-b416197e96f6` | **28/10/2026** | 631 | **168** |

E — o ponto que importa para dinheiro:

- **Documentos repetidos entre as duas importações: `0`**
- **Documento duplicado dentro da travada: `0`**

**Não houve dupla contagem.** A reimportação de 28/10 completou o que faltava
(472 + 168 = 640 títulos) sem reinserir nenhum documento já existente — o
`upsert(onConflict, ignoreDuplicates)` de [Borderos.jsx:137](../../src/components/../pages/Borderos.jsx#L137)
fez o trabalho.

**Logo: não há recuperação pendente de dado.** O que resta é **um status errado
numa linha de trilha.** A recuperação possível é:

1. **Recomendada** — `update importacoes set status='CONCLUIDO', observacao='…'`
   nessa única linha, **por id**, registrando que 472 títulos / 471 acordos /
   **R$ 620.870,89** entraram em 02/07/2026 e o restante em 28/10/2026, e que
   essa importação **não tem identidade de arquivo** (sem nome, sem hash).
   Uma linha, reversível, nada financeiro é tocado.
   **Não executado** — depende de autorização e o executor é a sessão principal.
2. **Não fazer nada** — é defensável: a linha `PROCESSANDO` é o registro honesto
   de que aquela tentativa não terminou, e `Importacoes.jsx:56` já a mostra como
   `travado`, que é verdade.
3. **Nunca** — reprocessar o borderô 333. Reprocessar hoje tentaria reinserir
   títulos que estão pagos, negociados e em confirmação.

**Não executei nenhuma das três**, conforme instruído.

### Efeito colateral que a linha travada causou — achado novo

[Borderos.jsx:359-368](../../src/pages/Borderos.jsx#L359) avisa "esse borderô já
foi importado" filtrando por `.eq("status","CONCLUIDO")`. A única importação
anterior do 333 estava em `PROCESSANDO` — **o aviso não apareceu em 28/10**.
Quem reimportou não foi avisado de que o 333 já havia entrado parcialmente.

Deu certo por sorte do `ignoreDuplicates`, não por desenho. A correção é tirar o
`.eq("status","CONCLUIDO")` desse aviso: para *avisar*, qualquer tentativa
anterior conta. **Não aplicada** — está no patch do item 3 como hunk separado e
opcional.

---

## 3. Filtros afetados por `CONCLUIDO` vs `Concluída`

### A divergência é perfeitamente segregada por tipo

| tipo | status | qtd |
|---|---|---|
| `ACORDOS` | **`Concluída`** | **157** |
| `BORDERO` | `CONCLUIDO` | 159 |
| `BORDERO` | `PROCESSANDO` | 1 |
| `PROJECAO_DIARIA` | `CONCLUIDO` | 338 |
| `PROJECAO_DIARIA` | `SUBSTITUIDA` | 238 |
| `PROJECAO_DIARIA` | `EXCLUIDA` | 2 |
| `CORRECAO_DUPLICIDADE` | `CONCLUIDO` | 1 |
| `RECONCILIACAO_PAGAMENTOS` | `CONCLUIDO` | 1 |

`Concluída` aparece **só** em `tipo='ACORDOS'`, e **toda** importação de acordos
usa essa grafia. Zero mistura.

### Origem

Uma linha, hardcoded, em `public.importar_acordos`:

```sql
insert into public.importacoes (id,tipo,referencia,arquivo_nome,usuario,status,retroativo)
values (p_importacao_id,'ACORDOS','Relatorio de Titulos em Aberto (Acordo)',
        'Relatorio Titulos em Aberto',v_usuario,'Concluída',false)
```

### Varredura completa: RPCs, views, crons e telas

Procurei em quatro lugares, não só na tela.

**(i) Funções do banco.** Busquei em `pg_proc.prosrc` por comparação de status
com `CONCLUID`/`Conclu*`. Doze funções casaram — e **nenhuma delas compara
`importacoes.status`**:

| Função | Que tabela ela realmente compara | Afeta? |
|---|---|---|
| `preventivo_carteiras`, `preventivo_sinc_situacao`, `preventivo_acao_preparar` | `prev_sinc.status = 'CONCLUIDA'` | **não** — outra tabela |
| `concluir_confirmacao_saldo_zero`, `historico_confirmacoes_por_dia`, `_confirmacao_sem_valor_sai_da_fila` | `solicitacoes_confirmacao_pagamento.status = 'CONCLUIDA_SALDO_ZERO'` | **não** — outra tabela |
| `projecao_importar_pagamentos`, `projecao_checar_importacao_existente`, `projecao_excluir_importacao`, `projecao_reprocessar_importacao`, `tg_notif_projecao_atualizada` | `importacoes.status`, **sempre com `tipo in ('PROJECAO_DIARIA','PROJECAO_RETROATIVA')`** | **não** — `Concluída` é só de `ACORDOS` |

**(ii) Views e matviews.** Quatro citam `importacoes`:
`vw_importacao_conferencia` (recorta `tipo in ('PROJECAO_DIARIA','PROJECAO_RETROATIVA')`),
`vw_estoque_carteira` (`JOIN importacoes i ON i.id = t.importacao_id AND i.tipo = 'BORDERO'` — **lê, mas não filtra status**),
`vw_pagamento_suspeita_pendente` e `vw_extracao_validacao_trilha` (**não leem
`status`**). Nenhuma afetada.

**(iii) Crons.** Busquei em `cron.job.command` por `importacoes`/`CONCLUID`/
`Conclu*` nos 60 jobs: **nenhum**. Nenhum cron filtra status de importação.

**(iv) Telas.** Quatro comparações, todas recortadas por tipo na origem.

### Quanto cada filtro erra hoje, ponto a ponto

| # | Ponto (`arquivo:linha`) | O que compara | Recorte na origem | **Quanto erra hoje** | O que o usuário vê de errado |
|---|---|---|---|---|---|
| 1 | [src/pages/Importacoes.jsx:56](../../src/pages/Importacoes.jsx#L56) — `if (linha.status !== "CONCLUIDO") agregado.travado = true` | status de borderô | `relatorio_importacoes_bordero` tem `where i.tipo = 'BORDERO'`; só existem `CONCLUIDO` (159) e `PROCESSANDO` (1) | **0 linhas** | **Nada de errado.** Marca como travado só o Borderô 333, que está travado de verdade |
| 2 | [src/utils/conferenciaPorArquivo.js:134](../../src/utils/conferenciaPorArquivo.js#L134) — `importacao_status !== "CONCLUIDO"` acrescenta o status ao rótulo | status de projeção | `importacao_conferencia_arquivos` tem `where i.tipo in ('PROJECAO_DIARIA','PROJECAO_RETROATIVA')` | **0 linhas** | **Nada de errado.** Mostra `· SUBSTITUIDA` / `· EXCLUIDA` onde é o caso — 240 linhas legítimas |
| 3 | [src/pages/ProjecaoHoraHora.jsx:2085-2104](../../src/pages/ProjecaoHoraHora.jsx#L2085) — `imp.status === "CONCLUIDO"` / `"SUBSTITUIDA"` / `"EXCLUIDA"` | status de projeção | a carga em `:607` usa `.in("tipo", ["PROJECAO_DIARIA","PROJECAO_RETROATIVA"])` | **0 linhas** | **Nada de errado** |
| 4 | [src/pages/Borderos.jsx:364](../../src/pages/Borderos.jsx#L364) — `.eq("status","CONCLUIDO")` no aviso de duplicata | status de borderô | `.eq("tipo","BORDERO")` | **0 linhas pela grafia** — mas **1 linha pelo status `PROCESSANDO`** | **Aqui há defeito, e não é a grafia:** o Borderô 333 ficou invisível ao aviso, e quem reimportou em 28/10 **não foi avisado** de que ele já havia entrado com 472 títulos e R$ 620.870,89 |
| 5 | Aba de acordos (`listar_importacoes_acordos`) | — | não expõe `status` | **0** | nada |

**Total do erro atribuível à divergência de grafia: 0 linhas, em 0 pontos.**

As 157 linhas `Concluída` são **todas** de `tipo='ACORDOS'`, e nenhum dos 5
pontos recebe linhas de `ACORDOS`. **Veredito: armadilha latente, não defeito
ativo.** O diagnóstico original afirmava que um filtro erra por 157 linhas —
**estava errado, e está corrigido lá.**

**O defeito real encontrado nesta varredura é o ponto 4**, e a causa é o status
`PROCESSANDO` não contar como tentativa anterior — não a acentuação.

O registro de que a divergência já incomodou está em
[CriticasImportacaoAcordos.jsx:12](../../src/components/CriticasImportacaoAcordos.jsx#L12):
*"as 136 importações de ACORDOS estavam todas 'Concluída'"*.

### A correção preparada

Arquivo: [patch-status-importacao-compativel.patch](patch-status-importacao-compativel.patch)
— **não aplicado**.

Desenho, em três decisões:

1. **Não reescreve histórico.** Nenhum `UPDATE` nas 157 linhas. A grafia
   histórica fica como está — é o que de fato foi gravado.
2. **Não muda `importar_acordos`.** Trocar a string exigiria migration e criaria
   um terceiro regime (ACORDOS antigos `Concluída`, novos `CONCLUIDO`). Fica
   registrado como decisão separada, para aprovação, **fora deste PR**.
3. **Torna o leitor tolerante.** Um util puro `ehImportacaoConcluida(status)` que
   normaliza acento e caixa e aceita `CONCLUIDO`, `Concluída`, `CONCLUÍDA`,
   `concluido`. Com teste. Quem comparar status de importação daqui pra frente
   usa o util e não precisa saber da divergência.

**Por que o patch não foi aplicado:** as duas comparações existentes estão
**corretas** para o escopo que recebem, e aplicar o util nelas hoje não muda
nenhum resultado — só adiciona código. Aplicar vira obrigatório no momento em
que alguém ler `importacoes` sem recortar por `tipo`. A decisão é da Amanda.

O patch tem **3 hunks independentes**:

| Hunk | O quê | Efeito |
|---|---|---|
| **A** | novo `src/utils/statusImportacao.js` + teste | nenhum efeito em tela; ferramenta |
| **B** | usa o util em `conferenciaPorArquivo.js:134` e `Importacoes.jsx:56` | nenhuma mudança de comportamento hoje; blinda o futuro |
| **C** | tira `.eq("status","CONCLUIDO")` do aviso de duplicata em `Borderos.jsx:364` | **muda comportamento**: passa a avisar sobre tentativa anterior travada (o caso do 333) |

Hunk C é o único com efeito real e **resolve o furo do item 2**. Pode ser
aplicado sozinho.

---

## 4. Candidatos e benefício esperado — antes de qualquer exclusão

Conforme pedido, nada é proposto para exclusão aqui. O quadro para decidir:

| Candidato | Qtd | Recuperável | Benefício | Risco | Veredito desta frente |
|---|---|---|---|---|---|
| `_backup_pos_import_*` **vazias** | 213 | **1.704 kB** | −213 objetos de catálogo (−14,5%) | nenhuma dependência; são vazias | **viável, ganho pequeno** — fazer só depois do `revoke` |
| `_backup_pos_import_*` **com conteúdo** | 335 | 7.912 kB | −335 objetos | **11.645 linhas de lastro de desfazer financeiro**; PITR desligado | **NÃO recomendado agora** |
| outras `_backup*` / `_excecao*` | 648 | parte de 58 MB | — | inclui reparos de reimportação | **caso a caso, fora desta frente** |

**Benefício total máximo do recorte `_backup_pos_import_*`: 9.616 kB = 0,34% do
banco de 2.791 MB.** O argumento honesto para a limpeza é **número de objetos de
catálogo**, nunca espaço, e permanece **não comprovado** em desempenho.

---

## 5. O que ficou aberto

1. **`revoke TRUNCATE`** (e provavelmente `DELETE`/`UPDATE`) de `authenticated`
   nas 548 tabelas — exige migration e aprovação; **passa pela skill
   `seguranca-rls`**. Mais urgente que a limpeza.
2. **Status do Borderô 333** — 3 caminhos no item 2; nenhum executado.
3. **Hunk C do patch** — aplicar ou não o aviso de duplicata mais abrangente.
4. **`importar_acordos` grava `Concluída`** — padronizar ou não, decisão separada.
5. **Medição de desempenho** antes/depois, se a limpeza for aprovada.

Nada acima é executado por esta frente. Migration, exclusão e alteração de dado
têm **executor único**: a sessão principal, com autorização explícita.
