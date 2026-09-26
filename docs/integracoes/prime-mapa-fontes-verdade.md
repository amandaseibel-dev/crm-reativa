# Mapa de fontes de verdade

Responde, sem nova investigação: **"preciso da informação X — onde o ReATIVA
busca?"**. Ver [README.md](README.md) para o índice e a regra de uso ("antes
de criar fallback, consultar este mapa").

| Informação | Fonte oficial | Endpoint / objeto | Chave | Confiável para automação? |
|---|---|---|---|---|
| CPF do aluno | Prime | `student_composite` → `registrationData.cpf` | `registration` | SIM |
| Nome (como a pessoa é chamada) | Prime | `registrationData.socialName` (prioridade) ou `.fullName` | `registration` | SIM — `socialName` primeiro |
| Telefone / endereço / e-mail | Prime | `registrationData.phones[]` / `.address` / `.email` | `registration` | SIM, só complementa (nunca sobrescreve o que já existe) |
| Curso, campus, turno, situação acadêmica | Prime | `student_composite` (topo) e `contracts[]` | `registration` | SIM |
| Contrato vigente (aluno estuda hoje?) | Prime | `contracts[]` sem `cancelledAt` e `validTo >= hoje` | `registration` | SIM |
| Matrícula Prime a partir de CPF/nome | Prime | `students_search` | CPF formatado ou nome | CONDICIONAL — nome nunca decide, só CPF exato |
| Filiação a um portador (166, 195 ou **202 judicial**) | Prime | `students_search?carrierId=N` (varredura) ou consulta pontual | CPF | SIM — **do CPF, nunca de um título**: ver RESTRIÇÃO DE ARQUITETURA em `prime-mapa-identificadores.md` |
| **Condição jurídica vigente (aluno/CPF)** | Prime, portador 202 | `prime_aluno_no_juridico(cpf)` → SIM / NAO / INDETERMINADO | CPF | SIM — **`NAO` só com snapshot 202 completo e válido**; estar no 195 NÃO prova ausência (37 dos 72 CPFs do 202 estão também no 195) |
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
