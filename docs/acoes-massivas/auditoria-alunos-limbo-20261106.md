# Auditoria de alunos no limbo — 06/11/2026

**Escopo:** somente leitura, projeto Supabase `ahattpqrjmhkzsmnbdzs`.
**Consultas:** apenas `SELECT` e a função de universo de Ações Massivas em modo de leitura. Nada foi escrito, aplicado, redistribuído, acionado ou alterado.
**Relação com outros trabalhos:** não altera a PR #832 nem a entrega da Fase 2 (`docs/acoes-massivas/entrega-fase2-universo-responsavel-caso.md`).

## 1. Critérios e horários

- **Base de dívida:** universo de Ações Massivas com `operador = todos` e `tipo_cobranca = MENSALIDADES_E_ACORDOS`.
- **População:** 18.456 alunos em `public.alunos` (não há flag de "ativo" no modelo; o total é a população).
- **Dia de referência:** `(now() at time zone 'America/Sao_Paulo')::date`.
- **Fuso da sessão:** UTC. Isto é relevante para o item 3 de divergências.
- **Snapshots:** a carteira muda ao longo do dia. Os números abaixo vêm de três leituras em horários diferentes e **não são um único instante**. Cada seção indica o snapshot de origem.

| Snapshot | Horário (UTC) | Origem |
|---|---|---|
| S1 | ~14:11 | Reconciliação original (seção 4) |
| S2 | ~14:40 | Verificações complementares (seção 5) |

## 2. Números originais (S1, preservados)

| Categoria | Alunos |
|---|---|
| Base com dívida (universo) | 13.649 |
| A. Elegíveis, disponíveis agora | 9.151 |
| B. Retorno futuro | 2.923 |
| B. Ação massiva recente (≤10 dias) | 762 |
| C. Liquidado no Prime | 320 |
| C. Confirmação de pagamento pendente | 204 |
| C. Encerrado operacionalmente | 179 |
| C. Fora do tipo de cobrança | 110 |
| Fora da base (sem dívida elegível) | 4.807 |
| **Total** | **18.456** |

Reconciliação S1: 9.151 + 2.923 + 762 + 320 + 204 + 179 + 110 = 13.649. Verificado.

Outros números de S1: disponíveis sem nenhum acionamento = 63; disponíveis com responsável inativo = 96; disponíveis com fidelização ativa = 1.320; disponíveis com data de acionamento entre 0–9 dias = 846; exatamente 10 dias = 726; 11–20 = 3.703; 21–30 = 1.570; mais de 30 = 2.247.

## 3. Divergências explicadas

### 3.1. Retornos bloqueados: 2.923 × 2.914 × 2.917 × 3.001

Não são erros de contagem, são leituras em instantes diferentes:

| Leitura | Total de retorno futuro | Até 10 dias | Maior prazo |
|---|---|---|---|
| S1 (contagem por motivo) | 2.923 | — | — |
| S1 (consulta à tabela de alunos) | 2.917 | 2.914 | 56 dias |
| S2 | 3.001 | 2.998 | 56 dias |

Dentro de cada leitura, a conta fecha: 2.914 + 3 = 2.917, e 2.998 + 3 = 3.001. O número **2.914 é somente "até 10 dias", não o total**. O total de retorno bloqueado varia porque a data de retorno e o estado da carteira mudam no dia.

### 3.2. "Retornos em até 10 dias" × "máximo de 56 dias"

Em S2, dos 3.001 bloqueados por retorno futuro, 2.998 vencem em até 10 dias e 3 em prazo maior; o maior é 56 dias. (Em S1, a distribuição foi: 2.914 em até 10 dias, 2 em 11–30 e 1 em 31–90.) **Não há retorno indefinido.** Os três casos acima de 10 dias são justificáveis pelo próprio agendamento e não configuram limbo.

### 3.3. Disponível na prévia TODOS × receber uma ação massiva

"Disponível" no universo **não garante** que o aluno receba a ação. O caminho de uma ação passa por:

1. **Universo** (`acoes_massivas_universo`): `disponivel = true`.
2. **Prévia** (`acoes_massivas_previa`): aplica o filtro de acionamento (`TODOS`, `NAO_MES`, etc.), o limite de quantidade, a ordenação por prioridade e o recorte por canal.
3. **Canal:** em WhatsApp exige telefone; em e-mail exige e-mail. Em S2, dos 9.936 disponíveis: 9.805 têm telefone e 9.694 têm e-mail. Os 131 sem telefone ficam fora de WhatsApp.
4. **Exportação** (`acoes_massivas_exportar`): revalida pelo universo e registra a ação.
5. **Confirmação do lote** e disparo externo, fora do banco.

Por isso o número da prévia pode ser menor que o de disponíveis.

### 3.4. Fidelização: critério exato

- **Função:** `caso_dentro_prazo_fidelizacao(dua)` retorna `true` quando `dua + 10 >= current_date`.
- **Leitura prática:** protegido no dia `dua + 10` (inclusive). Liberado a partir do dia `dua + 11`.
- **Divergência de fuso:** a sessão está em UTC, então `current_date` é o dia UTC. Entre 21h e 24h de Brasília, o dia UTC já é o seguinte, e a proteção termina um dia antes do esperado. Não medi a contagem exata desse efeito, que depende do horário da consulta.
- **Divergência de regra no universo:** a fidelização **não é filtro** do universo. Ela aparece como coluna informativa (`fidelizacao_ativa`). A proteção só existe quando há responsável definido e a seleção é por responsável (`CASO:`) ou por `livres`. Em `TODOS`, o filtro de responsável é desligado (`f_outro = false`), então a fidelização não protege nada.

## 4. Os 1.320 (S1) e 1.327 (S2) fidelizados em TODOS

**Confirmado:** sim, esses alunos podem ser selecionados antes do prazo em `TODOS`, sem disparar nada.

- Em S2: 1.327 disponíveis com fidelização ativa; **todos** têm responsável definido e data de acionamento dentro de 10 dias.
- A prévia de `TODOS` não exclui fidelizados (o `el` seleciona apenas `disponivel` e o filtro de acionamento).
- A exportação revalida pelo mesmo universo, então os mantém.

**Não executei prévia nem exportação**, porque gravam em tabelas de prévia e lote. A conclusão vem da leitura das definições das funções.

## 5. Responsáveis inativos (96 em S1; 120 em S2)

- **Universo:** esses alunos aparecem como disponíveis **somente** em `TODOS`. Em `CASO:<inativo>` também aparecem, desde que alguém escolha esse e-mail.
- **Responsáveis (`acoes_massivas_responsaveis`):** o inativo entra na lista com a classe `INATIVO`, desde que tenha caso ou acordo. Não é redistribuído automaticamente.
- **Receptivo:** `sistema_assumir_receptivo` exige que o operador seja ativo (`internal.nome_operador_ativo`). Um operador inativo não assume. **Não confirmei** o critério de entrada desses alunos na fila receptiva; esta é uma lacuna.
- **Canal em S2:** 113 dos 120 têm telefone.
- **Sobreposição:** 5 dos 120 também têm fidelização ativa (aparecem nos 1.327).

**Classificação:** falha de distribuição comprovada pela regra (não há responsável ativo), não "esquecimento" comprovado. Confirmar a fila receptiva antes de classificar como esquecido.

## 6. Classificação consolidada (com sobreposições)

| Grupo | Alunos (S2 salvo indicação) | Observação |
|---|---|---|
| **Comprovadamente sem atendimento por falha operacional** | 63 (S1), sem dado em S2 | Disponíveis sem nenhum acionamento. Não há dívida presumida: estão na base. |
| **Falha de distribuição (responsável inativo)** | 120 | Pode sobrepor fidelizados (5) e nunca-acionados. |
| **Risco de acionamento antes do prazo** | 1.327 | Fidelizados disponíveis em `TODOS`. Sobrepõe o grupo de inativos em 5. |
| **Bloqueios legítimos** | retorno futuro 3.001; ação recente 762 (S1); liquidado 320 (S1); confirmação 204 (S1); encerrado 179 (S1); fora do tipo 110 (S1) | Justificados pela regra. |
| **Sem dívida elegível** | 4.807 (S1) | Fora da base. |
| **Dados insuficientes** | 110 (só caso, sem título nem parcela); 40 datas divergentes; 18 datas sem movimento | Precisam de confirmação. |

**Sobreposições:** fidelizados e nunca-acionados são disjuntos por definição (fidelização exige data de acionamento). Inativos × fidelizados: 5. Inativos × nunca-acionados: não calculado.

## 7. Inconsistências que ainda precisam de confirmação

1. **Volatilidade do universo:** disponíveis passaram de 9.151 (S1) para 9.936 (S2) em ~30 minutos, e retornos bloqueados de 2.923 para 3.001. Não identifiquei a causa (possivelmente virada de retornos ou recálculo). **Precisa de medição contínua** antes de qualquer número ser tratado como fixo.
2. **Fuso UTC na fidelização:** confirmar com um teste controlado que a proteção termina no dia de Brasília.
3. **Duas fontes de data de acionamento:** o universo usa a data do movimento; a fidelização usa `alunos.data_ultimo_acionamento`. 40 disponíveis divergem entre si e 18 têm data sem movimento.
4. **Fila receptiva de responsável inativo:** confirmar o critério de entrada.
5. **Dívida só por caso (110):** o saldo do caso não está ligado a título aberto.

## 8. Correções em ordem de prioridade (não executadas)

1. **Alta — fidelização em TODOS:** decidir se `TODOS` deve respeitar a fidelização (a regra diz que sim). Hoje libera 1.327.
2. **Alta — responsável inativo:** definir destino dos 120 (gestão redistribui ou receptivo assume). Não redistribuí.
3. **Média — fuso da fidelização:** trocar `current_date` por `(now() at time zone 'America/Sao_Paulo')::date` em `caso_dentro_prazo_fidelizacao`.
4. **Média — fonte única de data de acionamento:** reconciliar `alunos.data_ultimo_acionamento` com os movimentos.
5. **Média — dívida só por caso:** exigir título ou parcela vencida, ou marcar como dados insuficientes.
6. **Baixa — monitorar volatilidade:** medir o universo em horários fixos antes e depois da Fase 2.

## 9. Conclusão objetiva

- **Comprovadamente sem atendimento por falha operacional:** 120 disponíveis com responsável inativo (S2) e 63 disponíveis nunca acionados (S1). Não somam por sobreposição; o total de únicos não foi calculado.
- **Risco de acionamento antes do prazo:** 1.327 fidelizados disponíveis em `TODOS` (S2).
- **Inconsistências a confirmar:** volatilidade do universo; fuso UTC; duas fontes de data; fila receptiva; dívida só por caso.
- **Correções antes da Fase 2:** itens 1 e 2 da seção 8; os demais podem vir depois, mas devem ser registrados.

## 10. Limitações

- Não executei prévia, exportação, nem nenhuma função que grave.
- Não medi valores financeiros: não há ligação confiável entre caso e título nesses grupos. Nenhum valor foi estimado.
- Não avaliei o receptivo além da função de assumir.
- Os números variam entre leituras; use os snapshots indicados.
