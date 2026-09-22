# Mapa de identificadores

Toda relação entre IDs que a integração Prime/ULBRA usa hoje, e o que cada um
vale para matching automático. Particularmente importante para re-acordo, onde
usar o ID errado já causou dobra de dívida (ver memórias
`acordo-vinculo-re-acordo-deterministico` e `parcela-renegociada-nao-cancela`).

| Identificador | Quem gera | Formato | Único? | Estável? | Serve para matching automático? | Relaciona com |
|---|---|---|---|---|---|---|
| **CPF** | Receita Federal | 11 dígitos | Sim, por pessoa | Sim | SIM — é a chave universal | tudo |
| **`registration`** (matrícula Prime) | Prime/ULBRA | numérico (ex. `2025001213`) | Sim, por vínculo acadêmico | Sim | SIM, mas **não é sinônimo automático** da matrícula do CRM | `alunos` via CPF, não via igualdade direta de matrícula |
| **matrícula do CRM** (`alunos.matricula`) | CRM (import histórico) | variável | Não garantido | Não garantido | **NÃO assumir igual à `registration`** — medido pelo menos 1 caso divergente (CRM 180 = Prime 2025001442) | só via CPF |
| **matrícula do arquivo Santander** | Santander (relatório da carteira 166) | igual em forma à `registration` | Sim, no arquivo | Sim | **SIM — bate com `registration` em 13 de 13 casos conferidos** | é a mesma coisa que `registration`, evidência direta, não a mesma coisa que a matrícula do CRM |
| **`documentNumber`** (Prime, mensalidade) | Prime | 13 dígitos: base(9) = `010`+contrato, sequência(4) = parcela fracionária (÷100; terminado em `990` = parcela 9,9) | Sim | Sim | SIM, só dentro do extrato Prime — não existe no CRM | série (prefixo) agrupa parcelas do mesmo contrato |
| **`documentNumber`** (Prime, acordo) | Prime | 13 dígitos: `0`+`5`+acordo(6)+parcela(4) | Sim | Sim | SIM — decodificação provada (8/8 contra `acordos.numero_ulbra`) | acordo (6 díg. centrais) |
| **`boleto`** (Prime, financial-statement) | Prime | 7 dígitos | Sim | Sim | SIM — **é** `acordos_titulos.documento`, ponte confiável para portador 195 | `acordos_titulos.documento` |
| **título CRM (boleto de acordo)** | CRM/ULBRA | `5` + acordo(6) + parcela(4) | Sim | Sim | SIM — decodificação provada (8/8), ex. `050308850007` → acordo `30885`, parcela `7` | `acordos.numero_ulbra` |
| **`acordos.numero_ulbra`** | CRM (espelha o Prime) | numérico | Sim | Sim | SIM | boleto de acordo (decodificação acima) |
| **`pagamentos.titulo_numero`** | Arquivo Santander | já contém o **número do acordo** diretamente | Sim, quando presente | Sim | SIM — não precisa ser derivado do boleto | `acordos.id` (via número) |
| **`carrier.id`** (portador) | Prime | inteiro pequeno (95, 160, 166, 195, 202, ...) | Sim | Sim | SIM — é a chave, nunca o nome | ver tabela de portadores abaixo |
| **Nome (qualquer fonte)** | várias | texto livre | **NÃO** — homônimos confirmados (7 pares de CPFs diferentes com o mesmo nome-like em 01/09/2026) | Não | **NUNCA** — nome não vincula, nunca decide vínculo financeiro, é sempre secundário/sugestão | — |
| **`parcelas.boleto`** (CRM) | CRM | igual ao `boleto` da Prime, sem zero à esquerda (`ltrim`) | Sim (índice único `ux_parcelas_boleto`) | Sim | SIM — é a chave real do vínculo pagamento→parcela | `financial_statement[].boleto` |

## Portadores (carriers) mapeados

| ID | Nome | Convênio | `isCollectionAgency` | Papel |
|---|---|---|---|---|
| 95 | SANTANDER | 272036 | false | mensalidade corrente (ULBRA direto, fora do escopo Reativa) |
| 160 | SANTANDER | 272037 | false | irmão do 95, fora do escopo |
| **166** | **SANTANDER REATIVA** | **0272047** | false | **convênio bancário do boleto de ACORDO da Reativa** — nunca aparece em linha de extrato |
| **195** | **REATIVA RECUPERAÇÃO DE CRÉDITO** | null | true | **mensalidade em cobrança da Reativa — a carteira principal** |
| 165 | (judicial) | — | true | fora de escopo por decisão da gestão |
| 202 | REATIVA COBRANÇA JUDICIAL | — | true | fora de escopo por decisão da gestão |

## Regra de leitura da dívida (decidida pela gestão em 25/08/2026)

```
está no 195 (REATIVA RECUPERAÇÃO)   -> mensalidade em cobrança, AINDA DEVE
está no 166 (SANTANDER REATIVA)     -> negociou, virou ACORDO
não está em nenhum dos dois         -> QUITOU
```

Regra simples e não depende de adivinhar padrão de pagamento — mas **166 nunca
aparece em linha de extrato financeiro**, só na filiação (`students_search
?carrierId=166`). Por isso "está no 166" se confirma pela **listagem**, nunca
pelo extrato.

## Regras de matching, por ordem de confiabilidade

1. **CPF exato** (formatado na busca, comparado em dígitos puros no retorno)
2. **Boleto exato** (`parcelas.boleto` = `financial_statement[].boleto`, sem
   zero à esquerda)
3. **`documentNumber` decodificado** (série/prefixo aponta contrato ou acordo
   único)
4. **Número Ulbra único**
5. **Proximidade de data + valor** — NUNCA fonte de verdade sozinha; serve
   só como teste de consistência auto-verificável (ver Premissa 20 em
   `docs/PREMISSAS.md`) ou como sugestão para revisão humana
6. **Nome** — nunca vincula nada financeiro; serve só como pista secundária
   com aviso explícito na tela ("nome não é prova")

Ver também [prime-mapa-fontes-verdade.md](prime-mapa-fontes-verdade.md) para
qual identificador vale como fonte de verdade de cada informação.
