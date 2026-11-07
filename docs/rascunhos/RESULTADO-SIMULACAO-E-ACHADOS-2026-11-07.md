# Simulação executada e três achados — retenção das importações

**Data:** 07/11/2026 · **Ambiente:** PRODUÇÃO `ahattpqrjmhkzsmnbdzs`
**Natureza:** SOMENTE LEITURA. Nada excluído, nada reprocessado, nenhum status
alterado, nenhuma migration, nenhuma rotina automática.

Complementa [DIAGNOSTICO-RETENCAO-IMPORTACOES-2026-11-07.md](DIAGNOSTICO-RETENCAO-IMPORTACOES-2026-11-07.md)
e executa [simulacao-retencao-importacoes.sql](simulacao-retencao-importacoes.sql).

---

## 1. Simulação executada — `_backup_pos_import_*`

### Contagem exata (bloco 4 do SQL, 548 relações percorridas)

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

**Sim, e é substancial.**

- **472 linhas em `acordos_titulos`** com `importacao_id = bff088bd…`
- `borderos` com esse `importacao_id`: **0** (a tabela de staging está vazia no
  banco inteiro — confirmado no diagnóstico)

Situação dos 472 títulos **hoje**:

| Situação | Qtd |
|---|---|
| `ABERTO` | 457 |
| `CANCELADA` | 5 |
| `PAGO` | 5 |
| `NEGOCIADO` | 3 |
| `DUPLICADA` | 1 |
| `EM_CONFIRMACAO` | 1 |

**Esses títulos são dívida viva, em operação.** 5 já foram pagos, 3 negociados,
1 em confirmação. Não são resíduo de importação falha — são carteira.

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
   nessa única linha, **por id**, registrando que 472 dos 646 entraram em 02/07
   e o restante em 28/10. Uma linha, reversível, nada financeiro.
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

### Filtros afetados HOJE: nenhum

Todo consumidor de `importacoes.status` é recortado por `tipo` **na origem**:

| Consumidor | Recorte | Vê `Concluída`? |
|---|---|---|
| `relatorio_importacoes_bordero` → [Importacoes.jsx:56](../../src/pages/Importacoes.jsx#L56) `status !== "CONCLUIDO"` | `where i.tipo = 'BORDERO'` | **não** |
| `importacao_conferencia_arquivos` + `vw_importacao_conferencia` → [conferenciaPorArquivo.js:134](../../src/utils/conferenciaPorArquivo.js#L134) `importacao_status !== "CONCLUIDO"` | `where i.tipo in ('PROJECAO_DIARIA','PROJECAO_RETROATIVA')` | **não** |
| [ProjecaoHoraHora.jsx:607](../../src/pages/ProjecaoHoraHora.jsx#L607) e as comparações em `:2085-2104` | `.in("tipo",["PROJECAO_DIARIA","PROJECAO_RETROATIVA"])` | **não** |
| [Borderos.jsx:364](../../src/pages/Borderos.jsx#L364) `.eq("status","CONCLUIDO")` | `.eq("tipo","BORDERO")` | **não** |
| Aba de acordos (`listar_importacoes_acordos`) | — | não expõe `status` |
| Nenhuma função do banco | — | nenhuma filtra `importacoes.status` |

**Veredito: armadilha latente, não defeito ativo.** O diagnóstico original dizia
que um filtro erra por 157 linhas — **estava errado, e está corrigido lá**.

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
