# Carga histórica de outubro/2026 — conferência antes de gravar

Documento de **conferência**, não de execução. Nada aqui foi importado nem
registrado. Ele existe para que a decisão de carregar as quatro fotos seja
tomada sobre medida, e não sobre lembrança.

Medido em 2026-10-06 sobre os arquivos originais, antes de qualquer importação.

## 1. O escopo dos quatro relatórios — PENDENTE de confirmação da gestão

A pergunta que precisa de resposta antes da carga: **um dos arquivos foi
extraído com filtro de canal?** Se tivesse sido, a ausência de um aluno nele
não significaria regularização — significaria que ele nunca esteve ali.

**Esta pergunta segue em aberto.** O que está abaixo é indício a favor de que o
escopo é o mesmo; não é prova, e não substitui a confirmação de quem extraiu os
relatórios.

| Foto | Arquivo | Linhas | Sem telefone | Sem e-mail | Colunas |
|---|---|---:|---:|---:|---:|
| F1 — sexta, 02/10 | `relatorio_inadimplencia_16_2.csv` | 14.021 | 89 | 94 | 18 |
| F2 — 05/10, manhã | `relatorio_inadimplencia_17.csv` | 11.993 | 77 | 79 | 16 |
| F3 — 05/10, tarde | `relatorio_inadimplencia_17_whatsapp.csv` | 10.797 | 71 | 73 | 16 |
| F4 — hoje, 06/10 | `relatorio_inadimplencia (17).csv` | 6.298 | 45 | 45 | 16 |

**O indício.** O arquivo cujo nome diz `whatsapp` ainda carrega **71 linhas sem
telefone nenhum** — gente que não teria como receber WhatsApp. Um filtro por
"tem telefone" não teria deixado essas linhas passar. A taxa de preenchimento
também é praticamente idêntica nas quatro fotos (telefone 99,3%–99,4%, e-mail
99,3%), quando um recorte por canal faria essa taxa saltar para 100% naquele
campo.

**Por que isso não é prova.** O indício só descarta uma hipótese específica — a
de um filtro por "possui telefone". Ele não descarta as outras, e nenhuma delas
deixaria marca no preenchimento de contato:

- recorte por **unidade, curso, campus ou faixa de saldo**, decidido na origem;
- um público montado **fora do relatório** e depois exportado;
- parâmetro diferente na extração que nada tem a ver com canal (data de corte,
  situação acadêmica, tipo de boleto) — as colunas `Situação Acadêmica` e
  `Tipo de Boleto` vêm **vazias nos quatro arquivos**, então não dá para
  conferir por elas.

O nome do arquivo sugere que descreve **o que foi feito com ele depois**, e não
um filtro aplicado na extração — mas isso é leitura do nome, não medição.

**Pendente:** confirmação da gestão de que os quatro relatórios foram extraídos
com os **mesmos parâmetros**. Sem ela, a ausência de um aluno entre duas fotos
não pode ser lida como saída da base.

F1 traz duas colunas a mais (`Turma` e `Turno`) — template mais largo. Isso
mostra que **pelo menos um parâmetro de extração mudou entre F1 e as demais**,
o que é mais uma razão para a confirmação não ser dispensada. F2, F3 e F4 têm
cabeçalho idêntico entre si.

Observação de arquivo: `relatorio_inadimplencia (17) whatsapp.csv` é
**byte a byte igual** a `relatorio_inadimplencia_17_whatsapp.csv` (mesmo md5).
São quatro fotos distintas, não cinco.

## 2. O que a série diz — se o escopo for o mesmo

Os números abaixo valem **sob a hipótese** do item 1. Se um dos relatórios tiver
sido extraído com parâmetro diferente, eles mudam.

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

1. **Mesmo escopo nos quatro relatórios** (item 1). É o bloqueio principal:
   sem ele, "saiu da base" não se sustenta.
2. **Contexto de cada ação.** A ação já registrada ("Mensalidade de outubro",
   05/10) é `BOLETO_VENCIDO`. As outras duas precisam da definição da gestão.
3. **Público de cada ação.** Para cada envio: cobriu a remessa inteira ou uma
   lista? Sem isso, o resultado seria medido sobre gente que não recebeu.
4. **Hora dos envios.** Onde a hora não for comprovada, o envio é registrado
   com precisão `DATA` — e o resultado contra uma foto do **mesmo dia** fica
   pendente, por desenho. A foto seguinte resolve.
