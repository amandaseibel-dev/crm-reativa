# Carga histórica de outubro/2026 — conferência antes de gravar

Documento de **conferência**, não de execução. Nada aqui foi importado nem
registrado. Ele existe para que a decisão de carregar as quatro fotos seja
tomada sobre medida, e não sobre lembrança.

Medido em 2026-10-06 sobre os arquivos originais, antes de qualquer importação.

## 1. Os quatro relatórios têm o mesmo escopo

A pergunta que precisa de resposta antes da carga: **um dos arquivos foi
extraído com filtro de canal?** Se tivesse sido, a ausência de um aluno nele
não significaria regularização — significaria que ele nunca esteve ali.

| Foto | Arquivo | Linhas | Sem telefone | Sem e-mail | Colunas |
|---|---|---:|---:|---:|---:|
| F1 — sexta, 02/10 | `relatorio_inadimplencia_16_2.csv` | 14.021 | 89 | 94 | 18 |
| F2 — 05/10, manhã | `relatorio_inadimplencia_17.csv` | 11.993 | 77 | 79 | 16 |
| F3 — 05/10, tarde | `relatorio_inadimplencia_17_whatsapp.csv` | 10.797 | 71 | 73 | 16 |
| F4 — hoje, 06/10 | `relatorio_inadimplencia (17).csv` | 6.298 | 45 | 45 | 16 |

**Confirmado: nenhum filtro por canal.** A prova está na coluna "sem telefone".
O arquivo cujo nome diz `whatsapp` ainda carrega **71 linhas sem telefone
nenhum** — gente que não teria como receber WhatsApp. Um público filtrado por
canal não conteria essas linhas; conteria zero. O mesmo vale para e-mail. O
nome do arquivo descreve **o que foi feito com ele depois**, não um filtro
aplicado na extração.

Reforço: a taxa de preenchimento é praticamente idêntica nas quatro fotos
(telefone 99,3%–99,4%, e-mail 99,3%). Se uma delas fosse o recorte de um canal,
essa taxa saltaria para 100% naquele campo.

F1 traz duas colunas a mais (`Turma` e `Turno`). É um **template mais largo do
mesmo relatório** — colunas adicionais, não linhas a menos. F2, F3 e F4 têm
cabeçalho idêntico entre si.

Observação de arquivo: `relatorio_inadimplencia (17) whatsapp.csv` é
**byte a byte igual** a `relatorio_inadimplencia_17_whatsapp.csv` (mesmo md5).
São quatro fotos distintas, não cinco.

## 2. O que a série diz

Movimento entre fotos consecutivas, por identidade do título
(`matrícula + Dt Vcto + Vcto Origem`), sem filtro de origem:

| Intervalo | Saíram | Entraram |
|---|---:|---:|
| F1 → F2 | 2.126 | 101 |
| F2 → F3 | 1.190 | 1 |
| F3 → F4 | 4.536 | 52 |

Consolidado F1 → F4, **comparando título a título** (não subtraindo totais):
**7.837 saíram**, 6.140 continuam, 154 entraram ao longo da série.

Com o recorte de origem aplicado — só títulos com `Vcto Origem` dentro de
outubro/2026, que é a regra que o importador já aplica —, os números passam a
**7.828 que saíram** e **151 entradas na série**.

## 3. A palavra continua sendo "saiu da base"

Nenhum desses 7.828 tem pagamento confirmado nesta fonte. O relatório de
inadimplência não diz por que alguém sumiu: pode ser pagamento, cancelamento,
bolsa, renegociação ou mudança do recorte na origem. Enquanto a conferência com
o Prime não existir para esses títulos, o módulo diz **saiu da base**, e nunca
"pago" ou "recuperado".

## 4. O que ainda falta para carregar

Perguntas em aberto, que a carga não deve inventar:

1. **Contexto de cada ação.** A ação já registrada ("Mensalidade de outubro",
   05/10) é `BOLETO_VENCIDO`. As outras duas precisam da definição da gestão.
2. **Público de cada ação.** Para cada envio: cobriu a remessa inteira ou uma
   lista? Sem isso, o resultado seria medido sobre gente que não recebeu.
3. **Hora dos envios.** Onde a hora não for comprovada, o envio é registrado
   com precisão `DATA` — e o resultado contra uma foto do **mesmo dia** fica
   pendente, por desenho. A foto seguinte resolve.
