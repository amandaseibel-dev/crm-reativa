# Preventivo — o que é, como usar e o que ainda falta

Frente criada em 28/09/2026. **Operação separada da cobrança**: orienta o aluno
a pagar a mensalidade no WebAluno antes de ela virar dívida.

---

## 1. O que o Preventivo faz e o que ele não faz

| Faz | Não faz |
|---|---|
| Importa uma carteira de títulos por janela de vencimento | Não cria caso de cobrança |
| Consulta o Prime para ver o que mudou em cada título | Não cobra honorário |
| Separa públicos para o CRM de mensageria (WhatsApp e e-mail) | Não envia mensagem — quem envia é a mensageria |
| Mostra o movimento financeiro observado, título a título | Não negocia, não cria acordo, não gera link de pagamento |
| Tira da fila quem passou de 31 dias de atraso | Não transfere título para a cobrança |

**O mesmo aluno pode estar nas duas operações.** A separação é **por título**:
a identidade é `(carteira, matrícula do Prime, documento)`. Um pagamento
observado num título nunca atualiza os outros do mesmo aluno.

**Acesso:** só a Amanda da gestão (`amanda.seibel@aelbra.com.br`). A trava está
no banco — `public.preventivo_e_gestao()`, aplicada na RLS de toda tabela
`prev_*` e no começo de toda RPC `preventivo_*`. **Amanda ADM
(`cobranca07@aelbra.com.br`) não tem acesso**, e não é só a tela que bloqueia:
a consulta direta pela API do Supabase devolve zero linha.

**Janela:** o título sai das ações novas ao completar **31 dias de atraso**, em
dias de calendário no fuso **America/Sao_Paulo**. No dia 31 ainda é preventivo;
no 32 não é mais. Sair da janela **não** transfere nada para a cobrança — só
tira das ações novas; o histórico fica na tela, no filtro "fora da janela".

A janela de vencimento da carteira é **escolhida na criação** (data de / data
até). Não há antecedência padrão embutida.

---

## 2. Passo a passo

### a) Extrair o relatório do Prime

O relatório precisa trazer, por linha, **um título**, com estes campos:

| Campo | Obrigatório | Por quê |
|---|---|---|
| Matrícula do aluno (`registration` do Prime) | **sim** | é a chave da consulta ao Prime. A matrícula do CRM **não** serve: são numerações diferentes |
| Nome do aluno | **sim** | só para exibir; **nunca** identifica o título |
| Identificador do título (boleto de 7 dígitos ou documento de 13) | **sim** | é o que liga a linha ao extrato do Prime |
| Vencimento | **sim** | define a janela e o atraso |
| Valor do título | **sim** | é o denominador do painel |
| Saldo em aberto | não | se vier, é ele que entra como valor de entrada; se não vier, entra o valor do título |
| Competência / referência | não | aparece na tabela |
| Situação financeira | não | usada só para separar o que está cancelado na origem |
| Celular e e-mail | não | sem eles o aluno é separado do público, com o motivo |
| Unidade / contrato | não | só se for preciso distinguir título entre unidades |

> **O arquivo de contatos que já existe (nome + telefone) não serve como
> carteira.** Sem título, vencimento e valor não há o que acompanhar nem o que
> reconciliar. A tela recusa a importação e diz exatamente o que faltou.

**Não está documentado aqui por onde extrair esse relatório na interface do
Prime** — não foi possível verificar o caminho das telas, e inventá-lo seria
pior do que não dizer nada. Se o caminho não for óbvio, peça ao responsável
pelo Prime um relatório de títulos com **exatamente os campos obrigatórios
acima**, filtrado pelo período de vencimento desejado.

### b) Importar a carteira

`Preventivo → Importações`

1. Criar a carteira (nome + janela de vencimento).
2. Escolher o arquivo (`.xlsx`, `.xls` ou `.csv`, com linha de cabeçalho).
3. Nomear o lote.
4. Conferir o mapeamento das colunas (o sistema chuta, você confirma).
5. **Ver prévia** — ela não grava nada e roda a mesma validação da confirmação.
   Mostra alunos, títulos, valor total, novos, atualizações, duplicidades,
   registros fora do período, contatos ausentes e cada linha recusada com o
   motivo.
6. **Confirmar importação.**

**Reimportar o mesmo arquivo não duplica nada.** Título repetido é atualizado,
não criado de novo, e o **valor de entrada da carteira nunca é reescrito** — é
sobre ele que o painel calcula percentual. Um título presente em vários lotes
conta uma vez só no consolidado.

### c) Acompanhar quem pagou

`Preventivo → Carteira` e `Preventivo → Resultados`

O botão **Atualizar agora** consulta o Prime (uma consulta por aluno) e
atualiza a foto financeira. Duas atualizações simultâneas não existem: a trava
está no banco.

Leia o aviso no topo antes da tabela. Ele diz uma de três coisas: nunca
atualizado, desatualizado (mais de 36 horas desde a última atualização
**completa**), ou atualizado. Quando a consulta falha, os valores anteriores
ficam de pé e o aviso diz isso — falha nunca vira "conferido".

**Leia a seção 3 antes de interpretar o painel.**

### d) Exportar WhatsApp / e-mail

`Preventivo → Ações`

1. Dar nome à ação, escolher o canal e, se quiser, estreitar por vencimento.
2. **Revisar elegibilidade** — a tela lista quem entrou e quem ficou de fora,
   com o motivo: fora da janela de 31 dias, saldo zerado, situação cancelada na
   origem, sumiu do extrato, sem celular válido, sem e-mail válido, contato
   repetido entre alunos diferentes, ou o aluno já está no público por outro
   título.
3. **Exportar arquivo.** Saem dois CSV: o público e os separados (com motivo).
   O celular sai como `55` + DDD + celular, só dígitos. Telefone fixo e número
   incompleto **não** entram e **não** são "corrigidos".
4. **Registrar envio confirmado**, depois que a mensageria enviar de verdade.

**Exportar não é enviar.** Os quatro estados são separados de propósito:
`Preparada → Exportada → Envio confirmado`, ou `Cancelada`. Nada nesta frente
dispara mensagem — nem em produção, nem em teste.

---

## 3. Situação real da integração com o Prime

Medido em **28/09/2026**, com a chave atual.

**O que a API entrega, e é suficiente:**

- os títulos **a vencer** e em **atraso inicial** existem e são legíveis. Eles
  vivem no portador **95** ("SANTANDER CC 13050976-6 - CONVENIO 272036"), que é
  a mensalidade corrente da ULBRA — não é carteira da Reativa, e lê-lo não
  coloca ninguém em cobrança. No espelho de 28/09: 302.477 linhas, 17.718
  alunos, **19.795 títulos a vencer** e **7.182 com 1 a 31 dias de atraso**;
- vencimento, valor principal, desconto, multa, juros, honorário e total, por
  título;
- cadastro do aluno (telefone, e-mail) e contratos;
- paginação não é problema: `GET /students/{registration}` devolve o extrato
  inteiro sem paginar. Uma consulta por aluno, nunca por título.

**O que a API NÃO entrega — e isto muda o que o painel pode afirmar:**

- **não há campo de situação, status ou saldo em aberto.** Conferido ao vivo em
  28/09/2026: o extrato tem exatamente 13 campos (`documentNumber`, `dueDate`,
  `grossAmount`, `discountAmount`, `penaltyAmount`, `interestAmount`,
  `honorariumAmount`, `netAmount`, `paymentDate`, `paidAmount`, `boleto`,
  `isAgreementInstallment`, `carrier`) e **nenhum** diz se o título está pago,
  em aberto, cancelado ou renegociado;
- **`paymentDate` não é data de pagamento.** Vem preenchido em 100% das linhas
  de todo portador: 0 de 302.477 linhas do portador 95 têm a data nula,
  **inclusive os títulos que ainda vão vencer** — e, nesses, a data vem antes do
  vencimento em 19.705 de 19.705 casos;
- **`paidAmount` não é caixa.** É valor de tabela / dívida corrigida: aparece
  como o dobro exato do principal em título vencido, e maior que o principal em
  3.852 dos 19.705 títulos a vencer.

**Consequência, e ela está codificada no sistema:**

O Preventivo **não registra pagamento**. Ele registra **movimento de saldo**
observado título a título entre duas consultas, classificado em tipos
separados: saldo foi a zero, saldo diminuiu, saldo aumentou, mudou de portador,
sumiu do extrato, voltou ao extrato. Nenhum deles é chamado de pagamento, e o
campo `e_pagamento_comprovado` do banco existe, começa sempre falso, e só pode
mudar quando houver fonte com **data e valor** do pagamento.

No painel, **"valor recebido" aparece como indisponível, com o motivo escrito
na tela**, em vez de ser preenchido com a redução de saldo. Redução de saldo
inclui pagamento, mas também cancelamento, bolsa e renegociação — trocar um
pelo outro transformaria cancelamento em recuperação.

**Sumir do extrato não é pagamento** e não zera nada: o último saldo conhecido
é preservado, o título entra em `AUSENTE_NO_EXTRATO` e fica **fora** da conta de
redução.

**Nenhum ciclo real foi executado ainda.** A sondagem ao vivo de 28/09 confirmou
a forma da resposta; a sincronização completa depende da Edge Function
`prev-sincronizar` estar implantada, o que ainda não foi feito (ver seção 5).

---

## 4. O que falta — pedir ao responsável pelo Prime

Um item só, e ele é o que destrava o acompanhamento de pagamento:

> **Uma forma de saber a situação do título.** Em ordem de preferência:
>
> 1. um endpoint que devolva, por aluno ou por período, os **pagamentos**
>    recebidos com **data e valor** e o identificador do título (`boleto` ou
>    `documentNumber`);
> 2. ou um campo de **situação** (`pago` / `em aberto` / `cancelado` /
>    `renegociado`) e de **saldo em aberto** no `financial-statement` já
>    existente;
> 3. ou, no mínimo, a **URL que a tela de títulos do Prime consome** para
>    montar a situação que ela exibe — o dado existe na interface; o que não
>    foi identificado é a rota.
>
> Se a resposta for que a chave atual não tem esse escopo, o pedido é a
> **liberação do escopo** para a mesma `X-API-Key`.

Sem isso, o painel continua medindo redução de saldo e dizendo, com todas as
letras, que redução de saldo não é dinheiro recebido.

**Segundo item, menor:** o **modelo de importação do CRM de mensageria** (ou uma
amostra do arquivo que ele aceita). Hoje o Preventivo exporta um CSV genérico —
`nome;telefone;matricula;vencimento;valor` para WhatsApp e
`nome;email;matricula;vencimento;valor` para e-mail, com o celular já em
`55`+DDD+número. Com o modelo real em mãos, é meia hora de ajuste em
`src/utils/preventivo.js` (`COLUNAS_WHATSAPP` / `COLUNAS_EMAIL`).

---

## 5. Estado da entrega e reversão

| Item | Situação |
|---|---|
| Migrations (3) | **escritas e testadas, NÃO aplicadas em produção** |
| Edge Function `prev-sincronizar` | **escrita, NÃO implantada** |
| Telas (4 abas) | escritas; build e lint limpos |
| Testes | 42 de comportamento em PostgreSQL real + 24 de regra pura |
| Sondagem ao vivo do Prime | feita, só leitura, via Edge Function já existente (`prime-acordo`) |
| Rotina automática diária | **não criada** — criar cron em produção precisa de aprovação explícita (`regra-custo-sempre-avisar-antes`) |

**Reversão:** `supabase/rollbacks/20260928143743_preventivo_estrutura.rollback.sql`
desfaz as três migrations. Como a frente é nova e isolada (nenhuma tabela fora
do prefixo `prev_`, nenhuma chave estrangeira para a cobrança, nenhuma coluna
alheia alterada), a reversão é um drop limpo: não há estado da cobrança para
restaurar. O que se perde são as carteiras importadas — e **não há PITR neste
projeto**, então o arquivo começa com os comandos de exportação a rodar antes.

**Frequência sugerida para a rotina automática, quando for aprovada:** uma vez
por dia, de madrugada, fora da janela do mutirão de sábado do
`prime_extrato_mutirao`. O custo é **uma chamada por aluno da carteira
preventiva** — não por título, e não pela base inteira. A ULBRA não documenta
limite de requisição, e os cabeçalhos `x-ratelimit-*` nunca vieram preenchidos;
por isso a concorrência da função é 8 (metade da usada pela cobrança), para não
disputar banda com a operação.

---

## 6. Ver as telas sem banco (preview)

```
npx vite --config vite.preview-preventivo.config.js
```

Abre em `http://localhost:5197/preventivo`. Os componentes são os reais do PR;
o que está dublado é a camada de serviço (`.preview-preventivo/mock-supabase.js`),
com dados inventados. Sem login, sem banco, e nada é enviado a ninguém.
