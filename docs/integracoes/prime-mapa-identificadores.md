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

## RESTRIÇÃO DE ARQUITETURA — a filiação ao portador é por CPF, nunca por título

**Descoberta em 2026-09-24, registrada por decisão da gestão.**

`prime_portador_membro` guarda `(cpf, portador, ciclo, coletado_em)`. Não existe
coluna de título, boleto ou matrícula: a varredura
`students_search?carrierId=N` devolve alunos, e a Edge deduplica por CPF (no
195, 41.194 itens da API viram 20.318 CPFs).

**Consequência, que vale mesmo com o snapshot 202 completo e válido:** sair do
portador 202 é um fato do **CPF**, não de cada título daquele CPF. Nos 262
títulos judiciais cancelados em 01/09/2026 são 60 CPFs para 262 títulos —
média de 4,4 e máximo de 7 títulos por CPF.

**Portanto, antes de qualquer `titulo_reativar`:** não se pode assumir que a
saída do CPF do portador 202 prova que *cada* título daquele CPF deixou de
estar em condição jurídica. É preciso uma de duas coisas:

1. uma **evidência adicional em nível de título**; ou
2. comprovar, pela regra oficial da Prime/ULBRA, que o portador jurídico é
   necessariamente uma condição aplicada ao **aluno/CPF inteiro** — e nesse
   caso a prova documental entra aqui.

Enquanto nenhuma das duas existir, a reversão de `CANCELADA` por causa judicial
fica bloqueada por desenho, não por falta de dado.

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

### ⚠️ Estar no 195 NÃO significa estar fora do jurídico

**Regra de negócio, medida em 2026-09-24.** Um CPF pode estar **simultaneamente**
nos portadores 195 (cobrança ReATIVA) e 202 (cobrança judicial). A filiação é
por CPF e não é exclusiva entre carteiras.

**Medição:** dos 72 CPFs no portador 202, **37 estão também no 195** — mais da
metade.

**Por que isso importa:** os 262 títulos cancelados por causa judicial pertencem
a 60 CPFs, e 35 deles apareciam no 195. Se a presença no 195 tivesse sido aceita
como evidência de que a condição jurídica acabou, **147 títulos / R$ 1.329.471,33
teriam sido reativados para cobrança de alunos que continuam em processo
judicial**. A coleta do 202 mostrou que os 262 seguem no portador judicial:
`prime_aluno_no_juridico` devolveu `SIM` para 262 de 262.

**Consequência para qualquer regra futura:** presença no 195 é, no máximo,
condição necessária. Nunca suficiente. A ausência do jurídico só pode ser
afirmada por `prime_aluno_no_juridico(cpf) = 'NAO'`, que exige snapshot do 202
completo e válido — e mesmo esse é um fato do CPF, não de um título
(ver "RESTRIÇÃO DE ARQUITETURA" acima).

### ⚠️ O limite de 720h de `prime_aluno_no_juridico` é INADEQUADO para reativação

`prime_aluno_no_juridico(cpf)` chama `prime_portador_snapshot_estado(202)` com o
**default de 720h (30 dias)**. Isso serve para leitura informativa, e **não
serve** para embasar reativação de título: um snapshot de três semanas pode
devolver `NAO` para um CPF que voltou ao jurídico nesse intervalo.

A função **não tem parâmetro de tolerância** hoje. Registrado em 2026-09-24 como
pendência conhecida, deliberadamente **não corrigida** para não antecipar
funcionalidade inexistente.

**Regra:** nenhuma `titulo_reativar` pode ser criada antes de existir trava
explícita de **no máximo 24h** na consulta que embasa a decisão. O limite de
**72h** do vigia é apenas para graduar alerta de degradação — **nunca** libera
título nem serve como evidência de saída do jurídico.

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
