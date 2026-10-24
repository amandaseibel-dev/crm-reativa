-- casos.data_ultimo_acionamento: datar o acionamento pelo dia de BRASILIA.
--
-- `fn_atualizar_ultimo_acionamento` grava `new.registrado_em::date`. O banco
-- roda em UTC (`current_setting('TimeZone')` = UTC), entao todo acionamento
-- entre 21h e 00h de Brasilia era datado no DIA SEGUINTE em
-- `casos.data_ultimo_acionamento` (que e `date`, nao `timestamptz`).
--
-- A propria funcao ja converte o fuso corretamente em outros pontos da cadeia
-- (`acoes_massivas_universo` usa `at time zone 'America/Sao_Paulo'` em v_hoje e
-- na recencia) -- isto aqui e inconsistencia interna, nao regra.
--
-- TAMANHO REAL, MEDIDO EM 15/10: **3 movimentacoes em 85.621** nos ultimos 180
-- dias caem na faixa deslocada; 155 casos tem `data_ultimo_acionamento`
-- diferente da data BRT do `alunos.data_ultimo_acionamento` e 65 estao
-- adiantadas. Ou seja: defeito real, impacto pequeno. Corrigido porque a data
-- alimenta a fidelizacao de 10 dias e o nivelamento, e porque um dia a mais
-- protege caso que ja deveria estar livre.
--
-- NAO corrige o passado: so passa a datar certo daqui para frente. Os 65 casos
-- adiantados se resolvem sozinhos no proximo acionamento.
--
-- Duas ocorrencias: a do SET e a da guarda "so avanca" do WHERE. As duas
-- precisam mudar juntas, senao a comparacao passa a confrontar datas de fusos
-- diferentes -- por isso `p_ocorrencias = 2` numa chamada so.

select internal.patch_funcao_ancorada(
  'public', 'fn_atualizar_ultimo_acionamento',
$ancora$new.registrado_em::date$ancora$,
$novo$(new.registrado_em at time zone 'America/Sao_Paulo')::date$novo$,
  2);
