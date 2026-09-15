> ## ⚠️ RASCUNHO INTERNO — NÃO ENVIADO, NÃO AUTORIZADO
>
> **Nada foi solicitado à ULBRA/TI.** Este texto é uma **opção futura**, redigida
> para estar pronta *caso* a gestão decida abrir frente externa — decisão que
> **ainda não foi tomada**.
>
> Enquanto este aviso existir:
> - não há solicitação em andamento;
> - não estamos aguardando resposta de ninguém;
> - a ULBRA **não** confirmou nem negou nenhuma limitação;
> - a resolução **não** depende, neste momento, de ação externa.
>
> O que está comprovado é apenas: **a superfície acessível pela nossa
> `X-API-Key` atual não expôs a estrutura financeira do carrier 166 nos testes
> realizados**. A hipótese de que o dado exista e esteja apenas não exposto é
> plausível e **não verificada**.
>
> Não enviar, encaminhar ou acionar ninguém sem autorização expressa da gestão.

---

# [RASCUNHO] Pedido técnico — acesso aos acordos do convênio 272047 (carrier 166)

**Destinatário previsto (se e quando for enviado):** TI ULBRA / responsável pela Prime API
**Origem:** ReATIVA Recuperação de Crédito — integração CRM
**Rascunho de:** 15/09/2026 · **status: não enviado**
**Chave de integração:** a `X-API-Key` já em uso pela ReATIVA

---

## O que precisamos

Um recurso da Prime API que exponha **os títulos e acordos do convênio 272047
(carrier 166 — SANTANDER REATIVA)**, incluindo **acordos já liquidados**, e não
apenas os que ainda têm título em aberto.

## Por que estamos pedindo

Recebemos diariamente o arquivo de pagamentos do Santander referente ao convênio
272047. Dele extraímos, de forma determinística, o número do acordo e o número da
parcela — o boleto segue o padrão `5 + acordo(6) + parcela(4)`, verificado em
**9.086 pagamentos sem uma única exceção**.

O problema é o outro lado: **2.481 acordos distintos, somando R$ 6.750.468,54 em
6.123 pagamentos**, não têm estrutura registrada no nosso CRM. São acordos que
foram fechados e pagos antes de entrarem no `Relatório de Títulos em Aberto` —
relatório que, por desenho, só traz acordo que ainda tem título em aberto no
instante da extração.

Sabemos o valor que entrou, o acordo e a parcela. Não sabemos o valor negociado,
o desconto, a entrada, quantas parcelas o acordo tinha, os vencimentos, o saldo
nem quais títulos originais foram negociados. Sem isso não conseguimos prestar
contas do acordo, nem saber se ele está quitado, quebrado ou renegociado.

## O que já verificamos do nosso lado

Para não tomar o tempo de vocês com o que dá para checar sozinho, medimos:

- **a filiação ao convênio está exposta e funciona.**
  `GET /students?carrierId=166` devolve 26.825 alunos e discrimina corretamente:
  para um CPF de teste, devolve o aluno em 166, 195 e 95, e devolve **zero** em
  portadores sem relação (100, 102, 202, 133, 149 e um id inexistente);
- **`GET /students/{registration}/financial-statement` nunca devolve linha do
  carrier 166.** Medido em 67 alunos e 1.625 linhas de extrato: aparecem 95, 160,
  171, 177, 178 e 195 — 166 em nenhuma;
- **não é sobre estar pago.** Testamos três acordos **ATIVOS**, com parcela em
  aberto e boleto conhecido pelo número (30885, 31078, 31281): nenhum aparece no
  extrato, nem por `boleto`, nem por `documentNumber`, nem por prefixo;
- **`GET /students/{registration}/agreements` responde 200 com lista vazia** em
  100% dos casos, inclusive para acordos que o nosso CRM tem como ATIVOS;
- **`isAgreementInstallment` é sempre `false`** nas 1.625 linhas;
- **a listagem do portador não tem dimensão financeira** — só
  `registration, name, cpf, course, status, admissionYear, graduated, campus,
  shift`;
- **não localizamos rota alternativa.** Testamos 48 caminhos candidatos
  (`/agreements`, `/negotiations`, `/installments`, `/titles`, `/documents`,
  `/billings`, `/renegotiations`, `/payment-plans`, `/carriers/{id}/titles`,
  variantes com `?registration=`, `?includeInstallments=`, `?expand=`,
  `?detail=full`, prefixos `/v1` e `/v2`): todos **404**, sem nenhum **405**, que
  indicaria rota existente com outro verbo. `swagger`, `openapi` e `docs`
  também 404.

## Os campos que precisamos, quando existirem

| campo | observação |
|---|---|
| identificador/número do acordo | o número que aparece no boleto (ex.: 71903) |
| `registration` e/ou CPF do aluno | para vincular à nossa base |
| títulos originais negociados | **quais** documentos entraram no acordo |
| quantidade total de parcelas | inclusive as já pagas |
| número de cada parcela | |
| boleto/documento de cada parcela | |
| valor e vencimento de cada parcela | |
| valor original e valor negociado | |
| desconto concedido | |
| entrada | se houver |
| encargos / honorários | |
| saldo | |
| status do acordo | |
| data de quitação | |
| quebra / cancelamento | com data e motivo, se houver |
| renegociação | e o vínculo com o acordo anterior |

## Perguntas objetivas

1. **Existe endpoint diferente do `/financial-statement`** que exponha os títulos
   e parcelas do convênio 272047 / carrier 166? Se sim, qual é o caminho?
2. **Nossa `X-API-Key` precisa de escopo ou permissão adicional** para receber os
   dados do carrier 166? A filiação chega até nós, mas nenhum título dele chega —
   isso é filtro de escopo ou o recurso simplesmente não existe na API?
3. **O recurso usado pela interface do Prime**, que exibe o acordo na tela, pode
   ser disponibilizado para integração? Se for um endpoint interno, é possível
   expô-lo ou criar equivalente?
4. **Existe endpoint ou relatório histórico do carrier 166** — que devolva também
   acordos já liquidados, e não apenas títulos atualmente em aberto?

## Três casos concretos para teste

Acordos pagos em 11 e 14/09/2026, presentes no arquivo Santander do convênio
272047, cujos alunos a própria API confirma no carrier 166, e que não têm
estrutura no nosso CRM. Servem de gabarito: qualquer recurso que vocês indicarem
deve conseguir devolvê-los.

| acordo | registration | parcelas pagas | total pago | pago em |
|---|---|---|---|---|
| **71903** | `2025012024` | 10 (0001–0010) | R$ 4.293,62 | 14/09/2026 |
| **71622** | `231027547` | 6 (0001–0006) | R$ 3.216,79 | 11/09/2026 |
| **71715** | `2025012515` | 1 (0001) | R$ 5.612,90 | 11/09/2026 |

Para os três, `GET /students/{registration}/financial-statement` devolve apenas
títulos dos carriers 95/177/195, e `GET /students/{registration}/agreements`
devolve lista vazia.

## Contato

Amanda Prado Seibel — amanda.seibel@aelbra.com.br
