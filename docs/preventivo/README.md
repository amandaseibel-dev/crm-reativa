# Preventivo — o que é, como usar e o que ainda falta

Frente criada em 28/09/2026. **Operação separada da cobrança**: orienta o aluno
a pagar a mensalidade no WebAluno antes de ela virar dívida.

> **Acompanhamento automático de pagamento: PENDENTE.** Não é uma escolha de
> desenho — é ausência de fonte. A seção 3 traz a prova, e a seção 4 traz o
> pedido técnico exato a fazer ao responsável pelo Prime. Enquanto isso não
> existir, o sistema mede **alteração do valor do título na fonte**
> (`netAmount`), que não é valor em aberto nem recebimento, e diz isso na tela.

---

## 1. O que o Preventivo faz e o que ele não faz

| Faz | Não faz |
|---|---|
| Importa a carteira **que você escolher**, do arquivo que você importar | Não monta carteira sozinho, nem por portador, nem por varredura |
| Consulta o Prime para ver o que mudou em cada título | Não afirma que alguém pagou — a fonte não permite |
| Separa públicos para o CRM de mensageria (WhatsApp e e-mail) | Não envia mensagem: quem envia é a mensageria |
| Tira das ações novas quem passou de 31 dias de atraso | Não transfere título para a cobrança |
| Mostra a alteração de valor observada, título a título | Não cria caso, não cobra honorário, não negocia, não gera link |

**A carteira é sua.** Nada entra nela a não ser pelo arquivo que você importa. O
portador 95 aparece nesta documentação como **informação técnica** — é onde a
mensalidade corrente vive no Prime, e é por isso que sabemos onde procurar o
título de cada linha. Ele **não** é público automático.

**O mesmo aluno pode estar nas duas operações.** A separação é **por título**.
Um título cujo valor mudou nunca atualiza os outros do mesmo aluno.

**Acesso:** só a Amanda da gestão (`amanda.seibel@aelbra.com.br`). A trava está
no banco — `public.preventivo_e_gestao()` — e vale em três portas: a RLS de
toda tabela `prev_*`, o início de **todas as 18 RPCs** `preventivo_*`, e o
começo da Edge Function, que confere pelo banco antes de pedir a chave do Prime.
Amanda ADM (`cobranca07@aelbra.com.br`) não passa em nenhuma delas.

**Janela:** o título sai das ações novas ao completar **31 dias de atraso**, em
dias de calendário no fuso **America/Sao_Paulo**, contados sobre o
**vencimento atual** do boleto (ver seção 2.a). Sair da janela **não transfere
nada**: muda só o status e a marca de saída, e há teste que compara o registro
inteiro antes e depois para garantir que nada mais mudou.

---

## 2. Passo a passo

### a) Extrair o relatório do Prime

O relatório que você já usa — **"Relatório de Inadimplência"**, exportado em CSV
— serve. Ele foi lido, campo a campo, do arquivo real de 28/09/2026
(`relatorio_inadimplencia 28.09.csv`, 3.495 linhas). O cabeçalho é:

```
Código · Nome do Aluno · Curso · Dt Vcto · Vcto Origem · Responsável ·
E-mail · Telefone · Endereço · Saldo Original · Saldo Atualizado ·
Estabelecimento · Processo · Escola · Situação Acadêmica · Tipo de Boleto
```

**O que cada coluna que importa quer dizer, medido:**

| Coluna | O que é | Como foi confirmado |
|---|---|---|
| **Código** | a **matrícula do aluno** (a `registration` do Prime), não um número de título | de 120 linhas conferidas contra o espelho de produção, 101 tinham a matrícula presente e as 101 casaram com título do aluno no portador 95; zero no portador 195 |
| **Dt Vcto** | o vencimento **atual** do boleto | nas 35 linhas em que ela difere de "Vcto Origem", 21 tinham o aluno no espelho e as 21 casaram com o Prime por esta coluna; **nenhuma** casou só por "Vcto Origem" |
| **Vcto Origem** | o vencimento **original** da mensalidade | serve para distinguir dois títulos do mesmo aluno e como competência; não rege a janela |
| **Saldo Original** | o saldo em aberto na extração | é o **valor de entrada** da carteira, e nunca é reescrito depois |
| **Saldo Atualizado** | o mesmo com encargos | guardado, não usado em conta |
| **Tipo de Boleto** | "Mensalidade" ou "Matrícula" | **não** é número de boleto. O importador ignora colunas "Tipo de…" de propósito: casá-la com o identificador faria a carteira inteira entrar errada |

**A limitação central do arquivo:** ele **não traz identificador de título** —
não tem boleto nem número de documento. Consequências, e nenhuma delas é
escondida:

1. dentro da carteira, a identidade do título é `matrícula + Dt Vcto + Vcto
   Origem` (foi o que bastou: das 3.495 linhas, só 14 ficaram duplicadas);
2. para achar o título **no Prime**, a ligação é `matrícula + Dt Vcto`, e só
   vale quando é inequívoca. Onde há mais de um candidato, o título fica
   **AMBÍGUO** e nenhum é escolhido. Na amostra de 120 linhas, 5 ficaram
   ambíguas;
3. **o valor não desempata** e não é usado para isso: só 23 das 120 linhas
   tinham "Saldo Original" igual ao `netAmount` do Prime.

Se algum dia o relatório passar a trazer boleto ou número de documento, o
importador usa esse campo automaticamente e a ambiguidade acaba — é o item mais
barato do pedido da seção 4.

> **Não está documentado aqui por onde extrair o relatório na interface do
> Prime.** Não foi possível verificar o caminho das telas, e inventá-lo seria
> pior do que não dizer nada.

### b) Importar a carteira

`Preventivo → Importações`: criar a carteira → escolher o arquivo → nomear o
lote → conferir o mapeamento → **ver prévia** → **confirmar**.

A prévia não grava nada e roda exatamente a mesma validação da confirmação.

**Resultado real do arquivo de 28/09/2026, ponta a ponta:**

| | |
|---|---|
| Linhas lidas | 3.495 |
| Aceitas | 3.485 (3.471 alunos) |
| Recusadas | 10 — 9 duplicadas no próprio arquivo, 1 sem nome (a linha final) |
| Saldo informado | R$ 5.689.824,38 |
| Reimportando o MESMO arquivo | 3.485 títulos e R$ 5.689.824,38 — **nada duplicou** |
| Fora da janela de 31 dias | 0 (o vencimento 05/09 tinha 23 dias em 28/09) |

**O mapeamento das colunas foi reconhecido sozinho**, incluindo "Código" →
matrícula e "Dt Vcto" → vencimento; nenhum campo obrigatório ficou faltando. Você
confere e troca na tela antes da prévia.

**Três correções que o arquivo real obrigou a fazer**, e que valem registro:

- o CSV vem em **LATIN-1** e tem **ponto e vírgula dentro de campo entre
  aspas** (a coluna E-mail traz dois endereços separados por `;`). Lendo de
  forma ingênua, 2.742 das 3.495 linhas eram descartadas;
- "Tipo de Boleto" estava sendo reconhecida como identificador do título;
- **`Vcto Origem` e `Saldo Atualizado` eram reconhecidos no mapeamento e
  descartados antes de chegar ao banco.** Sem `vencimento_origem`, a chave do
  título virava `"<Dt Vcto>|"` para todos, e dois títulos do mesmo aluno com o
  mesmo vencimento atual colidiam: **5 títulos e R$ 10.541,67 sumiam calados**.
  O caso mais claro é a matrícula 2026003068 — quatro mensalidades com o mesmo
  `Dt Vcto` (18/09) e origens 05/06, 05/07, 05/08 e 05/09 — que entrava como
  **uma só**. Coberto agora por
  `supabase/tests/preventivo_importacao_ponta_a_ponta.test.js`, que percorre o
  caminho inteiro a partir do texto do CSV.

### c) Contatos: o que entra e o que fica de fora

O campo Telefone traz vários números numa string só
(`"(51) 99547-2585, CEL:(51) 991859609, RES:51991859609"`). O sistema lê
**todos** e:

- exatamente **um** celular válido → usa;
- **mais de um** diferente → separa o aluno, com o motivo. Escolher um seria
  mandar mensagem para um número sorteado;
- fixo ou número incompleto → não vira celular, e não é completado.

No arquivo real: **2.688 linhas com um celular válido, 402 com mais de um, 405
com nenhum**.

E-mail tem o mesmo problema, em escala maior: **2.721 linhas trazem mais de um
endereço** (em geral o pessoal e o `@rede.ulbra.br`), 742 trazem um só, 27
nenhum válido. Por padrão, mais de um e-mail **separa** o aluno. Na aba Ações há
uma caixa explícita — *"usar o primeiro e-mail quando a linha trouxer mais de
um"* — que fica **desmarcada** por padrão, e a escolha fica gravada nos filtros
da ação.

**Públicos simulados com o arquivo real:**

| Canal | Entram | Ficam de fora |
|---|---|---|
| WhatsApp | **2.660 alunos** | 401 sem celular válido · 400 com mais de um celular · 11 com número compartilhado com outro aluno · 8 já no público por outro título |
| E-mail | **724** | 2.721 com mais de um e-mail · 27 sem e-mail válido · 5 com e-mail compartilhado · 3 já no público |

### d) Acompanhar

`Preventivo → Carteira` e `Preventivo → Resultados`. O botão **Atualizar agora**
consulta o Prime (uma chamada por aluno). Duas atualizações simultâneas não
existem — a trava está no banco.

Leia o aviso do topo antes da tabela: nunca atualizado, desatualizado (mais de
36h desde a última atualização **completa**) ou atualizado. Quando a consulta
falha, os valores anteriores ficam de pé e o aviso diz isso.

**Leia a seção 3 antes de interpretar os números.**

### e) Exportar e registrar o envio

`Preventivo → Ações`: nomear → canal → **revisar elegibilidade** → **exportar**
→ **registrar envio confirmado**.

Saem dois CSV: o público e os separados, com motivo. O celular sai como `55` +
DDD + celular, só dígitos.

**Exportar não é enviar.** `Preparada → Exportada → Envio confirmado` é ordem
obrigatória, e nada nesta frente dispara mensagem — nem em produção, nem em
teste.

---

## 3. Situação real da integração com o Prime

### O que a API entrega, e basta

- os títulos **a vencer** e em **atraso inicial** existem e são legíveis, no
  portador 95 ("SANTANDER CC 13050976-6 - CONVENIO 272036"), que é a
  mensalidade corrente da ULBRA. No espelho de 28/09: 302.477 linhas, 17.718
  alunos, 19.795 a vencer, 7.182 com 1 a 31 dias de atraso — **números do
  espelho (17.744 alunos enfileirados), não da base inteira da ULBRA**;
- vencimento, principal, desconto, multa, juros, honorário e total, por título;
- cadastro e contratos do aluno;
- paginação não é problema: `GET /students/{registration}` devolve o extrato
  inteiro. Uma consulta por aluno, nunca por título.

### O que a API NÃO entrega — com a prova

O `financialStatement` tem **13 campos**: `documentNumber`, `dueDate`,
`grossAmount`, `discountAmount`, `penaltyAmount`, `interestAmount`,
`honorariumAmount`, `netAmount`, `paymentDate`, `paidAmount`, `boleto`,
`isAgreementInstallment`, `carrier`. **Nenhum informa situação, status, valor
em aberto ou recebimento.** Conferido ao vivo em 28/09/2026.

A prova de que `paymentDate` e `paidAmount` não indicam pagamento **não usa o
próprio campo**: usa uma variável independente, o **seu relatório de
inadimplência de 28/09**, que diz por fora da API quem está em aberto naquele
dia. Cruzando 120 linhas dele com o espelho, 101 títulos ficaram confirmados
como **EM ABERTO**. Desses 101:

| | |
|---|---|
| com `paymentDate` preenchido | **101 de 101** |
| com `paymentDate` **posterior** ao vencimento | 19 |
| com `paidAmount` **igual** ao `netAmount` | 61 |
| com `paidAmount` menor que o `netAmount` | 27 |

As duas assinaturas que qualquer pessoa leria como "pagou com atraso" e "pagou o
valor cheio" aparecem **em massa em títulos que estão abertos**.

Comparando três grupos dos mesmos alunos no mesmo instante — 101 abertos, 24
mensalidades de jul/ago e 315 títulos futuros — **nenhum campo separa os
grupos**: `paymentDate` nulo = 0 nos três; `isAgreementInstallment` = false nos
três; portador = 95 nos três. Nos futuros, `paymentDate ≤ vencimento` em 315 de
315, o que confirma que é data de processamento, não de pagamento.

**Título cancelado não pôde ser validado**: não há, hoje, um exemplo confirmado
de título cancelado para comparar. Isso entra no pedido da seção 4.

### Não há outra fonte autorizada

- as rotas `/payments`, `/titles`, `/bills`, `/installments` e
  `/students/{reg}/titles` seguem **404** desde 15/09/2026 (48 rotas testadas);
- **nenhuma outra integração do CRM cobre isso**: `public.pagamentos` (9.584
  linhas, o extrato Santander da Reativa) tem `titulo_numero` de **5 dígitos**,
  que é o número do **acordo** da Reativa — estruturalmente incapaz de carregar
  pagamento de mensalidade do portador 95. O dinheiro dessas mensalidades vai
  direto para a ULBRA e não passa pela carteira da Reativa.

### O que o sistema faz, então

Registra **alteração do valor do título na fonte** (`netAmount`) entre dois
ciclos, com nome literal: `VALOR_FONTE_CAIU`, `VALOR_FONTE_ZEROU`,
`VALOR_FONTE_SUBIU`, `AUSENTE_NO_EXTRATO`, `MUDANCA_DE_PORTADOR`,
`VINCULO_AMBIGUO`. Há teste que lê a restrição da tabela e reprova se as
palavras "saldo", "pagamento", "liquid", "receb" ou "quita" aparecerem num tipo
de evento.

O painel mostra **duas grandezas que não se somam**: o **saldo informado pelo
arquivo** — ali a palavra saldo tem dono e definição, é a coluna "Saldo
Original" do relatório da ULBRA — e o **valor do título na fonte**
(`netAmount`), que é o valor do título e não um valor em aberto. E, no lugar de
"valor recebido", mostra o motivo pelo qual esse número não existe.

**Sumir do extrato não é recebimento**: o último valor conhecido é preservado,
o título vira `NAO_ENCONTRADO` e fica **fora** da conta.

---

## 4. O que falta — pedido técnico ao responsável pelo Prime

Copie daqui para diante.

> **Assunto: acesso a situação e recebimento de título — API Prime/ULBRA**
>
> Usamos hoje a API `https://prime-api.ulbra.ai/api` com uma `X-API-Key` de
> integração, apenas para leitura. Pelo endpoint
> `GET /students/{registration}`, o bloco `financialStatement` devolve 13
> campos: `documentNumber`, `dueDate`, `grossAmount`, `discountAmount`,
> `penaltyAmount`, `interestAmount`, `honorariumAmount`, `netAmount`,
> `paymentDate`, `paidAmount`, `boleto`, `isAgreementInstallment`, `carrier`.
>
> Nenhum deles informa se o título está **pago, em aberto, cancelado ou
> renegociado**, e nenhum informa **saldo em aberto**. Verificamos que
> `paymentDate` vem preenchido em 100% das linhas, inclusive em títulos que
> ainda vão vencer, e que `paidAmount` aparece igual ao `netAmount` em títulos
> que sabemos estar em aberto — ou seja, não conseguimos usá-los como prova de
> pagamento.
>
> Precisamos de **uma** das opções abaixo, em ordem de preferência:
>
> 1. **Endpoint de recebimentos.** Por aluno (`registration`) ou por período,
>    devolvendo, para cada pagamento: identificador do título (`boleto` de 7
>    dígitos **ou** `documentNumber` de 13), **data do pagamento**, **valor
>    pago**, e se houve **estorno/cancelamento do pagamento** (com data).
> 2. **Dois campos novos no `financialStatement` já existente:**
>    `situacao` (pago · em aberto · cancelado · renegociado) e
>    `saldoEmAberto` (decimal). Com esses dois, não precisamos de rota nova.
> 3. **A URL que a tela de títulos do Prime consome** para montar a situação que
>    ela exibe. O dado existe na interface; o que não identificamos é a rota.
>
> Se a limitação for de **escopo da chave** e não de existência do dado, o
> pedido é a liberação desse escopo para a mesma `X-API-Key`.
>
> **Pedido adicional, de custo baixo e efeito imediato:** incluir no
> **Relatório de Inadimplência** (o CSV com as colunas Código · Nome do Aluno ·
> Curso · Dt Vcto · Vcto Origem · … · Saldo Original · Saldo Atualizado) uma
> coluna com o **número do boleto** ou o **documentNumber** do título. Hoje o
> relatório não traz identificador de título, e por isso precisamos ligar cada
> linha ao Prime por matrícula + vencimento — o que fica ambíguo quando o aluno
> tem dois títulos com o mesmo vencimento (≈5% das linhas).
>
> **Para conferência:** precisamos também de **quatro exemplos conhecidos** —
> um título **pago**, um **em aberto**, um **a vencer** e um **cancelado**, com
> a matrícula e o identificador de cada um — para validar os campos contra casos
> confirmados, em vez de inferir.

**Segundo item, menor, e que não depende do Prime:** o **modelo de importação do
CRM de mensageria** (ou uma amostra do arquivo que ele aceita). Hoje exportamos
um CSV genérico — `nome;telefone;matricula;vencimento;valor` para WhatsApp e
`nome;email;matricula;vencimento;valor` para e-mail, com o celular já em
`55`+DDD+número. Com o modelo real, é meia hora de ajuste em
`src/utils/preventivo.js` (`COLUNAS_WHATSAPP` / `COLUNAS_EMAIL`).

---

## 5. Automação: como vai funcionar quando for ligada

O cron **não foi criado** — criar rotina em produção depende de aprovação
explícita (`regra-custo-sempre-avisar-antes`). O desenho proposto:

| | |
|---|---|
| Frequência | **1× por dia**, de madrugada, fora da janela do mutirão de sábado do `prime_extrato_mutirao` |
| Volume | **uma chamada por ALUNO da carteira** — não por título, não pela base. Com a carteira de 28/09 (3.471 alunos), são ~3.471 chamadas/dia |
| Fila própria | `prev_sinc_fila`. Não entra em `prime_extrato_fila`, que varre os ~17,7 mil alunos da base e só é drenada aos sábados |
| Concorrência | 8 requisições em paralelo (metade da usada pela cobrança), para não disputar banda com a operação |
| Limites | a ULBRA não documenta limite; os cabeçalhos `x-ratelimit-*` nunca vieram preenchidos. Por isso a concorrência é conservadora e o backoff é o mesmo já usado em produção (3 tentativas, 1,2s–3,6s, com tratamento de `503`) |
| Execução simultânea | impossível: `preventivo_sinc_abrir` recusa abrir um ciclo se já houver outro `EM_ANDAMENTO` para a carteira, e encerra como `FALHOU` qualquer ciclo pendurado há mais de 30 min |
| Retomada | a Edge Function processa até 110s e devolve `faltam`; chamar de novo com o mesmo `sinc_id` continua de onde parou, sem reconsultar quem já respondeu |
| Ciclo incompleto | **não vira "atualizado"**. Só um ciclo sem pendência e sem erro fica `CONCLUIDA`, e a tela mostra a última **completa** |

Até o cron existir, a atualização é pelo botão **Atualizar agora**.

---

## 6. Estado da entrega e reversão

| Item | Situação |
|---|---|
| Migrations (3) | escritas e testadas, **NÃO aplicadas em produção** |
| Edge Function `prev-sincronizar` | escrita, **NÃO implantada** |
| Telas (4 abas) | escritas; build e lint limpos |
| Testes | 121 do Preventivo (85 de comportamento e isolamento em PostgreSQL real + 36 de regra pura) |
| Importador com o arquivo real | validado ponta a ponta, 3.495 linhas |
| Ciclo real de sincronização com o Prime | **não executado** — depende do deploy da Edge Function |
| Cron diário | **não criado** |

**Reversão:** `supabase/rollbacks/20260928143743_preventivo_estrutura.rollback.sql`
desfaz as três migrations. A frente é nova e isolada — nenhuma tabela fora do
prefixo `prev_`, nenhuma chave estrangeira para a cobrança, nenhuma coluna
alheia alterada — então a reversão é um drop limpo. O que se perde são as
carteiras importadas, e **não há PITR neste projeto**: o arquivo começa com os
comandos de exportação a rodar antes.

---

## 7. Ver as telas sem banco (preview)

```
npx vite --config vite.preview-preventivo.config.js
```

Abre em `http://localhost:5197/preventivo`. Os componentes são os reais do PR; o
que está dublado é a camada de serviço (`.preview-preventivo/mock-supabase.js`),
com **dados inventados** — a faixa no topo da tela diz isso em letras grandes.
Sem login, sem banco, e nada é enviado a ninguém.

O dublê **não tem como ir ao ar**: ele lança erro se for carregado num build de
produção, só é ligado pela config exclusiva do preview, e há teste que reprova
se algum arquivo de `src/` passar a importá-lo ou se o `index.html` da aplicação
apontar para a entrada do preview.
