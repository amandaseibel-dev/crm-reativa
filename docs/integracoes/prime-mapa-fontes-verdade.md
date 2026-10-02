# Mapa de fontes de verdade

Responde, sem nova investigação: **"preciso da informação X — onde o ReATIVA
busca?"**. Ver [README.md](README.md) para o índice e a regra de uso ("antes
de criar fallback, consultar este mapa").

| Informação | Fonte oficial | Endpoint / objeto | Chave | Confiável para automação? |
|---|---|---|---|---|
| CPF do aluno | Prime | `student_composite` → `registrationData.cpf` | `registration` | SIM |
| Nome (como a pessoa é chamada) | Prime | `registrationData.socialName` (prioridade) ou `.fullName` | `registration` | SIM — `socialName` primeiro |
| Telefone / endereço / e-mail | Prime | `registrationData.phones[]` / `.address` / `.email` | `registration` | SIM, só complementa (nunca sobrescreve o que já existe) |
| Curso, campus, turno | Prime | `students_search` `items[]` e `contracts[]` do `student_composite` | `registration` | SIM |
| **Situação acadêmica** (Formado/Trancado/Cancelado/…) | Prime | **`students_search` → `items[].status` — e SÓ aí.** O `student_composite` NÃO traz situação: suas chaves de topo são apenas `registrationData`, `contracts`, `financialStatement`, `agreements` (medido em 6 alunos, 28/09/2026). `contracts[].status` é status de CONTRATO, vocabulário distinto, **nunca substituto** | CPF formatado (o `search` é por CPF/nome) | **CONDICIONAL — o status é por VÍNCULO DE CURSO, não da pessoa. Ver a ressalva abaixo** |
| Contrato vigente no período (NÃO "o aluno estuda hoje") | Prime | `contracts[]` sem `cancelledAt` e `validTo >= hoje` | `registration` | CONDICIONAL — diz que existe contrato válido no período, e **nada mais**. Não é prova de frequência, de matrícula ativa nem de vínculo acadêmico em curso |
| Matrícula Prime a partir de CPF/nome | Prime | `students_search` | CPF formatado ou nome | CONDICIONAL — nome nunca decide, só CPF exato |
| Filiação a um portador (166 ou 195) | Prime | `students_search?carrierId=N` (varredura) ou consulta pontual | CPF | SIM |
| **Mensalidade corrente: título a vencer e atraso inicial (0–31 dias)** | Prime | `financial_statement` / `student_composite`, linhas com `carrier.id = 95` ("SANTANDER CC 13050976-6 - CONVENIO 272036") | `registration` + `boleto` | SIM para EXISTÊNCIA, vencimento e valor. **NÃO para situação de pagamento** — ver linha abaixo |
| **Situação do título (pago / em aberto / cancelado) e saldo em aberto** | **NÃO EXPOSTA.** Medido ao vivo em 28/09/2026: `financialStatement` tem 13 campos e nenhum é situação, status ou saldo. `paymentDate` vem preenchido em 100% das linhas, inclusive em título a vencer (0 de 302.477 nulos no portador 95); `paidAmount` é valor de tabela (o dobro exato do principal em vencidos) | — | — | **NÃO.** Redução de saldo entre duas consultas é observável, mas mistura pagamento, cancelamento, bolsa e renegociação — nunca é recebimento por si |
| Título original (mensalidade) — existência | Prime | `financial_statement` (via `student_composite`) | `registration` | SIM |
| Título original — boleto (7 díg.) | Prime | `financial_statement[].boleto` | `registration` | SIM — é `acordos_titulos.documento` |
| Mensalidade liquidada (portador 195) | Prime | `financial_statement[].paymentDate` **+ regra de entrada em prod** (venc.+30, ≠ dia da importação) | `registration` + corte 23:57:13 UTC de 18/09/2026 | CONDICIONAL — nunca `paymentDate` isolado |
| Decomposição de valor (principal/multa/juros/honorário) | Prime | `financial_statement[].grossAmount/penaltyAmount/interestAmount/honorariumAmount` | `registration` | SIM |
| Caixa efetivamente recebido | **Santander** (arquivo/extrato bancário), NUNCA `paidAmount` da Prime | fora da API Prime | boleto / número Ulbra | SIM — Prime `paidAmount` é dívida corrigida, não caixa |
| **Estrutura do acordo** (parcelas, valor negociado, vencimentos) | **NÃO LOCALIZADA.** Visível na tela do Prime, rota não identificada. Em 22/09 o rastreamento de proveniência esgotou código, banco, logs, payloads e URLs do nosso ambiente — **censo de produção: `/agreements` nunca devolveu lista preenchida** (`auditoria.ACORDO_ENCONTRADO_NA_API` = 0) | — | — | **NÃO — ver Premissas 19/20 e prime-gaps.md § Rastreamento de proveniência** |
| Quem fechou o acordo / quais mensalidades ele substituiu | **NÃO EXPOSTO** por nenhuma rota testada (sondado especificamente pela Edge Function `prime-acordo`) | — | — | NÃO |
| Status do acordo (confirmado/quebrado/renegociado/cancelado) | **NÃO EXPOSTO** pela API | apenas visível na tela do Prime | — | NÃO |
| Vínculo mensalidade × acordo que a substituiu | **Nenhuma fonte externa.** Reconstrução interna do CRM por assinatura (aluno + data de liquidação), teto `ALTA_CONFIANCA`, nunca `CONFIRMADO` | `docs/CLASSIFICACAO-VINCULO-ACORDO-MENSALIDADE.md` | aluno + data | NÃO automatizar sem revisão — ver decisão da gestão de 12/09/2026 |
| Re-acordo / renegociação | Determinístico só pelo título: `'0'` + boleto da parcela do acordo anterior | CRM (`acordos_titulos`) | boleto | SIM, dentro do escopo medido (283 parcelas confirmadas) |
| Título liquidado na origem, sem ir para acordo | Prime | `financial_statement` do portador 195, com `origem_liquidacao='PRIME_LIQUIDACAO_OFICIAL'` (evidência auxiliar, `acordo_id` NULL por desenho) | `registration` + boleto | CONDICIONAL — nunca confundir com estrutura de acordo |
| Relatório "Títulos em Aberto" (Santander) | Prime, via exportação manual | fora da API JSON — arquivo | matrícula Santander = `registration` (13/13 confirmado) | NÃO é histórico — só traz quem ainda está em aberto no instante da extração; acordo pago desaparece dele para sempre |

## Como ler este mapa

- **Contrato vigente não equivale a "aluno estudando".** São coisas distintas: o
  contrato é o instrumento financeiro do período; a situação acadêmica é o
  estado do vínculo de curso, e vem de outro campo, de outro endpoint. Na
  amostra de 28/09/2026 os dois discordam com frequência — há contrato
  `Confirmado` vigente em vínculo cuja situação é `Formado`, e vínculo com
  situação `Matriculado Curso Normal` sem contrato vigente. Nenhum dos dois
  sozinho autoriza dizer que a pessoa está ou não estudando.

- **Situação acadêmica não é atributo da pessoa.** Na amostra de 6 alunos
  sondada em 28/09/2026, cada linha de `items[]` do `students_search` é um
  **vínculo de curso** (curso + campus + turno), com status próprio — e os
  status de uma mesma pessoa divergem entre si. Reduzir os vínculos a um status
  único por pessoa é perda de informação, não simplificação: escolher "a
  primeira linha" ou "a mais recente" produz rótulo que a fonte não afirma.
- **Não foi encontrado identificador estável do vínculo acadêmico nos endpoints
  e na amostra consultados**, e a chave composta não separa os vínculos. Ver
  [prime-mapa-identificadores.md](prime-mapa-identificadores.md#vínculo-acadêmico-curso--campus--turno).

- **"NÃO LOCALIZADA"** (estrutura do acordo) é diferente de **"não existe"**.
  A tela do Prime comprova que o dado existe; o que falta é a rota
  estruturada. Ver a formulação obrigatória em
  [prime-api.md](prime-api.md#agreements--acordos-do-aluno).
- Nenhuma linha desta tabela autoriza fallback por proximidade (data, valor,
  nome) como fonte "oficial" — proximidade é evidência auxiliar, nunca fonte
  de verdade, e some por completo quando existe fonte com chave exata.
- Antes de qualquer regra nova que leia dado da Prime, conferir a coluna
  "Confiável para automação?" — CONDICIONAL sempre tem a condição descrita em
  [prime-api.md](prime-api.md), não só aqui.
