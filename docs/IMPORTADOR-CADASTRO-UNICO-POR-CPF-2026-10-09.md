# Importador de borderô: um cadastro por CPF (09/10/2026)

**Estado: proposto em PR.** O código está no PR; o SQL de consolidação está em
`supabase/aguardando_aprovacao/` e **não foi aplicado**. Nada em produção foi
alterado por esta frente.

## O defeito, e a linha que o causava

Borderô 723 (`importacao_id 817bb231`, 08/10/2026 19:18, 2.155 linhas):
**14 CPFs ganharam de 2 a 5 fichas cada — 33 fichas no total.**

A causa era uma linha de `Borderos.jsx`:

```js
const linhasSemAluno = preview.linhas.filter((l) => !l.aluno);
inserirEmLotes("alunos", linhasSemAluno.map(/* ... */))
```

O borderô tem **uma linha por título**, não por aluno. Quem devia 6
mensalidades aparecia em 6 linhas; nenhuma batia com cadastro existente, e as 6
viravam 6 fichas. Depois, os títulos caíam todos numa delas — o mapa
`cpf -> aluno` guardava o último inserido — e as outras ficavam como cascas
vazias na busca e nas listas.

A assinatura na base é exata: **nº de fichas = nº de títulos do aluno**.

| caso | fichas | títulos |
|---|---|---|
| a aluna já corrigida em 09/10 | 6 | 6 |
| 1 CPF | 5 | 5 |
| 2 CPFs | 3 | 3 |
| 11 CPFs | 2 | 2 |

Este documento e os arquivos SQL **não trazem nome nem CPF**: o repositório é
público e a §7 de
[`PREMISSA_SEGURANCA_PROJETO.md`](seguranca/PREMISSA_SEGURANCA_PROJETO.md) manda
mascarar CPF e não registrá-lo. As fichas aparecem por `id` (uuid interno) e o
de/para com dado pessoal fica nas tabelas `_backup_*`, com RLS deny-all.

### A segunda porta, menos visível

A busca do cadastro existente comparava o CPF **já normalizado** do arquivo
(`padStart(11,'0')`) com a coluna `alunos.cpf` **crua**:

```js
buscarEmLotes("alunos", "cpf", cpfs, /* ... */)
mapaAlunosPorCpf[aluno.cpf] = aluno;   // chave crua
```

Medido em 09/10/2026: **32 fichas gravadas com máscara** e **10 com contagem de
dígitos diferente de 11**. Para essas, a busca não acha o cadastro que existe e
o importador cria outro. É a mesma família do `sistema_fusao_cpf_sem_zero`
citado em `20260909091338`.

## A correção

Três funções puras em [`src/utils/bordero.js`](../src/utils/bordero.js), fora do
componente para poderem ser testadas:

| função | o que garante |
|---|---|
| `chaveCpf` | identidade = só dígitos, 11 posições, zeros à esquerda preservados; `null` quando não há dígito (sem CPF não há correspondência segura, e não se inventa uma) |
| `indexarAlunosPorCpf` | indexa cadastro existente **por chave**, não pelo valor cru da coluna — ficha com máscara ou sem zero passa a ser reaproveitada |
| `fichasParaCriar` | **um registro por CPF distinto**, por mais linhas que o CPF tenha no arquivo |
| `alunoDaLinha` | todo título do mesmo CPF cai na **mesma** ficha |

A invariante que os testes fixam:

> nº de fichas criadas == nº de CPFs distintos sem cadastro — nunca nº de linhas.

Regra 1 de [`PADRAO_CADASTRO.md`](PADRAO_CADASTRO.md): a identidade é o CPF,
nunca o nome. Nenhuma dessas funções decide por nome; o casamento por nome do
preview continua onde estava e segue sendo só um palpite para evitar cadastro
novo.

## Testes

`src/utils/bordero.cadastroUnico.test.js` — 23 casos, incluindo as duas
regressões reais:

- as 6 linhas da aluna já corrigida criam **1** ficha, e as 6 apontam para ela;
- os 14 CPFs do borderô 723, com as quantidades de linha medidas em produção
  (33 linhas), criam **14** fichas e não 33;
- o mesmo CPF escrito de três jeitos (com máscara, sem zero à esquerda e
  normalizado) é **um** cadastro;
- cadastro existente com CPF em outro formato é reaproveitado, não duplicado;
- CPFs diferentes continuam sendo cadastros diferentes;
- linha sem CPF fica fora da dedução por chave e é devolvida à parte.

### Reimportação do mesmo borderô

É o caminho mais provável de voltar a duplicar: o arquivo é reenviado — de
propósito, como reforço de dados, ou sem perceber (a tela avisa, mas não
bloqueia). Na segunda passada o preview já acha os alunos criados na primeira,
e os testes provam que:

- nenhuma ficha nova nasce;
- as linhas continuam apontando para a **mesma** ficha da primeira passada;
- nenhum título existente é tocado — `motivoDeNaoTocar` recusa todos, porque o
  importador é insert-only desde 08/10/2026;
- título `NEGOCIADO`, `PAGO` ou com `status` `quitada` não volta a `ABERTO`;
- mensalidade **nova** do mesmo aluno entra na ficha que já existe, sem criar
  outra;
- reimportação com o CPF em outro formato (máscara no arquivo, ficha sem zero à
  esquerda no CRM) não cria ficha paralela.

As duas metades estão testadas juntas porque é a soma delas que dá a garantia:
`fichasParaCriar` não cria cadastro, e `motivoDeNaoTocar` recusa o título.

## Consolidação das 33 fichas: APLICADA em 09/10/2026

**Aplicada em produção**, versão registrada **`20261009192930`**
(`supabase/migrations/20261009192930_consolidar_19_fichas_duplicadas_vazias_bordero_723.sql`,
rollback em `supabase/rollbacks/`). Autorização expressa da gestão na mesma
data, restrita a essa exclusão. 19 fichas vazias apagadas, 14 mantidas.

Conferido antes e depois, por leitura independente das travas:

| | antes | depois |
|---|---|---|
| fichas dos 14 CPFs | 33 | **14** (cada CPF com exatamente 1) |
| as 19 vazias | existiam | **0** |
| títulos | 33 | **33** |
| valor | R$ 82.550,86 | **R$ 82.550,86** |
| títulos órfãos | 0 | **0** |
| movimentações | 17 | **17** |
| solicitação financeira aberta | 1 | **1** (intacta) |
| fichas com responsável | 1 | **1** |
| saldo somado | 2.694,02 | 2.694,02 (não tocado, de propósito) |

`audit_log`: 19 linhas `alunos/DELETE`, exatamente os 19 ids. Backup:
`_backup_alunos_dup_bordero723_20261009` (33 fichas) e
`_backup_shadow_dup_bordero723_20261009` (76 linhas), ambas com RLS deny-all e
sem grant. CPFs com mais de uma ficha na base inteira: **39 → 25** — o restante
é legado anterior a este borderô.

### A trava corrigida antes de aplicar

A auditoria *shadow* roda a cada 6 horas (00:40, 06:40, 12:40, 18:40) e grava 19
linhas por rodada, uma por ficha: eram 57 (execuções 71–73) quando o arquivo
nasceu e **76** (execução 74) na hora de aplicar. O portão tinha número fixo e
teria recusado a execução por causa do relógio, não dos dados. Passou a exigir a
**forma**, que não depende de quando se aplica: backup igual à tabela viva,
contagem múltipla de 19, 19 linhas por rodada, e **toda** linha
`SALDO_ZERO_DEFINITIVO` com `saldo_diagnostico = 0`. A última é a que vale:
qualquer linha que falasse de saldo faria o portão recusar, independentemente da
contagem. O rollback perdeu o literal pela mesma razão — o número certo é o que
o backup guardou.

## Inconsistência registrada para correção separada

**13 das 14 fichas principais têm `saldo_total` nulo** apesar de carregarem
**R$ 79.856,84** em títulos abertos. Só uma tem saldo calculado (R$ 2.694,02 — a
que está em atendimento). O borderô gravou os títulos e não recalculou o saldo
dessas fichas, então esses 13 alunos provavelmente não aparecem em carteira,
fila e indicadores, com dívida existindo. **Nenhuma frente desta data mexeu em
saldo**, por decisão da gestão. É uma frente própria: descobrir por que a
importação não dispara o recálculo de situação para a ficha que recebe os
títulos.

## O texto da proposta, antes de ser aplicada

`supabase/aguardando_aprovacao/20261009190000_consolidar_19_fichas_duplicadas_bordero_723.sql`
(com rollback ao lado) apaga as **19 fichas vazias** e mantém as 14 que têm a
dívida. Mesmo desenho da correção já aplicada para a Thamis
(`20261009180500`), com o limite da gestão — *"não podemos apagar alunos com
dívida"* — implementado como **portão**: a transação aborta se qualquer ficha da
lista tiver saldo, valor em aberto, caso, acordo, título, pagamento ou uma única
linha em qualquer tabela viva de `public` com `aluno_id`.

Total devido dos 14 CPFs, conferido antes e depois pelo próprio arquivo:
**R$ 82.550,86** em 33 títulos.

## Dois débitos que ficam explícitos

1. **Linha sem CPF.** A regra 4 de `PADRAO_CADASTRO.md` manda ir para
   quarentena, e a quarentena não existe. Recusar a linha derrubaria no chão o
   título que hoje é gravado, então o comportamento continua — uma ficha por
   linha sem CPF — e a tela passa a **dizer quantas foram** (43 fichas sem CPF
   na base em 09/10/2026). O que mudou para elas é só não misturar mais títulos
   de pessoas diferentes numa ficha só.
2. **O índice único em `alunos.cpf_limpo` continua bloqueado.** Em 09/10/2026
   há **39 CPFs com mais de uma ficha** na base inteira — 14 deste borderô, o
   resto é legado (ver `PADRAO_CADASTRO.md`, "O que ainda bloqueia"). Criar o
   índice agora falharia sobre os dados atuais. A ordem é a documentada:
   resolver as famílias, depois instalar a garantia. Por isso **este PR não
   traz o índice** — traria uma migration que não pode ser aplicada.
