-- Acoes Massivas: varios status academicos de uma vez.
--
-- Amanda, 08/09/2026: "tem como colocar uma opcao de selecionar os casos por
-- status academico?" -- e, oferecida a escolha, "varios de uma vez".
--
-- O filtro de status academico ja existia, mas aceitava UM status por vez.
-- Para separar, por exemplo, "Matriculado" e "Aguardando matricula" numa
-- mesma acao, era preciso rodar duas vezes. Agora `p_situacao_academica`
-- aceita varios status separados por "|", no mesmo formato que `p_unidade`
-- passou a aceitar em 28/08 (migration 20260828320000). Um status sozinho
-- continua funcionando igual, entao nada que ja chamava a funcao quebrou.
--
-- POR QUE A CIRURGIA E FEITA NO BANCO E NAO RECOPIANDO A FUNCAO: a versao
-- VIVA em producao tem 13 parametros (canal e faixa de valor no banco, vindos
-- de 02/09), e o repositorio na main so registra 10. Reescrever o corpo aqui
-- escolheria uma das duas versoes e apagaria a outra. Lendo a definicao viva
-- e trocando so a linha do filtro, o resto fica byte a byte identico, seja
-- qual for a versao instalada.
--
-- Falha ALTO: se houver mais de uma sobrecarga, ou se a ancora nao aparecer
-- exatamente uma vez, a migration aborta em vez de instalar algo diferente do
-- esperado. CREATE OR REPLACE preserva os GRANTs existentes (authenticated e
-- service_role), entao nao ha grant a refazer.

do $migration$
declare
  v_def    text;
  v_qtd    int;
  v_ancora text := '(p_situacao_academica IS NULL OR nullif(btrim(a.situacao_academica),'''') = p_situacao_academica)';
  v_nova   text := '(p_situacao_academica IS NULL OR nullif(btrim(a.situacao_academica),'''') = ANY(string_to_array(p_situacao_academica, ''|'')))';
begin
  select count(*) into v_qtd
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acoes_massivas_previa';
  if v_qtd <> 1 then
    raise exception 'acoes_massivas_previa: esperava exatamente 1 sobrecarga, achei % -- revise antes de aplicar', v_qtd;
  end if;

  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acoes_massivas_previa';

  if position(v_nova in v_def) > 0 then
    raise notice 'acoes_massivas_previa ja aceita varios status academicos; nada a fazer';
    return;
  end if;

  if (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora) <> 1 then
    raise exception 'ancora do filtro de status academico nao encontrada exatamente uma vez em acoes_massivas_previa -- a funcao mudou, revise a migration antes de aplicar';
  end if;

  execute replace(v_def, v_ancora, v_nova);
end $migration$;
