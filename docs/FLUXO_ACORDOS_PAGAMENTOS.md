# Fluxo único: da entrada do acordo até a finalização

Amanda, 31/08/2026: *"construa esse movimento de forma organizada para que o
sistema CRM converse com os relatórios de pagamentos"* — *"um fluxo único desde
a entrada até a finalização do acordo"*.

## A regra de negócio que sustenta tudo

**Tudo vira acordo.** Todo pagamento é feito através de um novo acordo. Por isso
o extrato do Santander só traz **boleto de acordo** — os 8.465 pagamentos com
documento têm todos o mesmo formato: 11 dígitos começando com `50`. Pagamento de
mensalidade avulsa não passa por ali.

**A troca de portador é manual.** Quando a equipe negocia, move o aluno do
portador **195** (ReATIVA Recuperação de Créditos = mensalidade em cobrança) para
o **166** (Santander ReATIVA = virou acordo). Nenhum outro portador é carteira da
ReATIVA — o 95, com 262.799 boletos, não entra em conta nenhuma.

## A chave que liga as pontas

O número do documento é `título(5) + parcela(4)`, e ele aparece nos dois lados:

| onde | exemplo |
|---|---|
| `acordos_titulos.documento` (do relatório da Ulbra) | `050648080001` |
| `pagamentos.numero_parcela_completo` (do extrato) | `50660010001` |

Mesmo número, um zero a menos na frente. Casa com
`ltrim(documento,'0') = ltrim(numero_parcela_completo,'0')`.
Os **4 últimos dígitos são o número da parcela**.

## O fluxo, etapa por etapa

### 1. Entrada — o relatório da Ulbra

`/importar-acordos` lê o **Relatório de Títulos em Aberto**, filtra
`Tipo de Boleto = Acordo` e grava um título por parcela.

Colunas que o importador exige: `Tipo de Boleto`, `Documento`, `CPF Aluno`,
`Titular`, `Vcto`, `A Receber Bruto`, `Estabelecimento`, `Situação do Aluno`.
Coluna com nome diferente = linha descartada em silêncio.

**Não duplica**: a trava é do banco, não da tela —
`where not exists (... where t.documento = i.documento)`. Em 19/08 o arquivo
tinha 435 parcelas e entraram 275; em 12/08, 327 → 321.

**O que ele NÃO faz**: não cria parcelas, não cria vínculo, e grava fixo
`'ABERTO'` — ignorando se o título já foi pago.

### 2. O perigo — a dívida contada duas vezes

Título de acordo `ABERTO` **sem vínculo** é o estado que **soma no saldo**. Como
a parcela do mesmo acordo já soma, importar sem tratar dobra a dívida.

Medido em 31/08: subir 8.410 títulos (R$ 10.618.693,32) levou a carteira de
**R$ 47,1 mi** para **R$ 50,1 mi** antes do tratamento.

### 3. Tratamento — `acordos_pos_importacao()`

Na ordem, e só sobre títulos `ABERTO` sem vínculo:

1. documento aparece no extrato → **PAGO** (não é dívida)
2. o resto casa com a **parcela do acordo** pelos 4 últimos dígitos + valor
   exato → grava o boleto na parcela, cria o vínculo, vira **NEGOCIADO**
3. segunda passada por **valor** para o que não casou por número
4. `recalcular_situacao_aluno` **por último**

Resultado de 31/08: 7 marcados pagos, **8.025 vinculados**, carteira de
R$ 50,1 mi para **R$ 48,5 mi**.

### 4. Baixa — `baixa_por_documento_aplicar()`

O extrato baixa a parcela pelo documento, trazendo junto:

- **valor pago** — 355 de 355
- **honorário** — 353 de 355 (o extrato é mais completo que o CRM, que tem
  honorário em apenas 17 parcelas; só preenche onde falta, nunca sobrescreve)
- **operador** — 355 de 355, 37 operadores

Sem `p_confirmar` a função **só conta**. Backup antes de escrever.

### 5. Duplicidade — `acordos_sinalizar_boleto_repetido()`

Dois boletos do mesmo aluno com **conjunto de vencimentos idêntico** = mesma
dívida renegociada. **Quem manda é o boleto, não o número do acordo no CRM**:
no caso do Gilberto, o acordo 3410 (número maior, criado depois) carrega o
boleto mais velho.

**Sinaliza, nunca cancela** — os dois boletos vieram no mesmo arquivo da Ulbra,
que lista ambos como cobráveis.

### Orquestrador

`fluxo_pagamentos_executar(p_confirmar, p_desde)` roda as quatro etapas na ordem
e devolve carteira antes/depois mais o resultado de cada uma. Em modo prévia,
nada é escrito.

## O que este fluxo NÃO resolve

**O relatório de títulos em aberto não traz o que já foi pago.** Prova pelo
sufixo do documento: a parcela `0001` (a entrada, já paga) tem 310 linhas contra
1.577 da `0002` — a curva deveria cair, não subir. A entrada some do relatório.

Consequência: o passado só fecha pelo extrato do Santander, que começa em
**01/07/2026**. Antes disso não há com o que cruzar.

O Prime também não resolve: o portador **166 nunca devolve uma parcela**
(+9.000 varridas, zero) e `/agreements` vem vazio em 100% dos alunos testados.
O relatório da Ulbra é a única fonte dos boletos de acordo.

## Resíduo conhecido em 31/08

384 títulos, R$ 414.492,78, cada um com motivo nomeado:

| motivo | títulos | alunos | valor |
|---|---|---|---|
| sobrou parcela livre, nenhuma com esse valor | 312 | 228 | R$ 328.566,00 |
| o CRM tem menos parcelas que a Ulbra | 54 | 51 | R$ 50.231,87 |
| acordo nunca lançado no CRM | 18 | 4 | R$ 35.694,91 |

Backups: `_backup_pos_import_20260831`.
