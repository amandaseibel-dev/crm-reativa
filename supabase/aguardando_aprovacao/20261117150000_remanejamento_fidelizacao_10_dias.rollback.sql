-- ROLLBACK de 20261117150000_remanejamento_fidelizacao_10_dias
--
-- O QUE REVERTER REINTRODUZ, EM LETRAS MAIUSCULAS:
--
--   O REMANEJAMENTO VOLTA A ENTREGAR CASO SEM FIDELIZACAO AO NOVO RESPONSAVEL,
--   VOLTA A NAO REVALIDAR ELEGIBILIDADE, SALDO NEM FIDELIZACAO DE TERCEIROS NA
--   EXECUCAO, E A PREVIA VOLTA A MEDIR CAPACIDADE POR OUTRA CONTA.
--
-- Como reverte: desfaz cada trecho da migration na definicao VIVA das tres
-- funcoes e so conclui se o corpo resultante tiver o md5 de producao de
-- 17/11/2026. Se outra frente alterou a funcao depois, o trecho nao bate ou o
-- md5 final diverge, e o rollback aborta inteiro sem escrever por cima.
--
-- Marcas: o rollback apaga SOMENTE as marcas cujo MARCADOR e o deste lote E cuja
-- data e a que o lote gravou. Nao olha o dono atual: a marca e do lote enquanto
-- nenhuma outra escrita de giro a tiver regravado (o gatilho solta o marcador).
--
-- O que NAO e desfeito, de proposito:
--   * a coluna carteira_geral_auditoria.protecao_ate fica (e registro do que
--     aconteceu; a funcao restaurada nao a le nem a escreve).
--
-- DML: somente o UPDATE de giro_fidelizacao_ate descrito acima, nas marcas
-- casadas pelo predicado. Nenhuma outra linha de dado e escrita.

begin;

-- 1. so marcas com o MARCADOR deste remanejamento E a data que ele gravou.
--    Marca de outra rotina nao tem o marcador; marca posterior com outra data
--    nao casa. Nada e apagado por dono, por data sozinha ou por predicado.
update public.casos c
   set giro_fidelizacao_ate = null, remanejamento_lote_id = null
  from public.carteira_geral_auditoria a
 where a.caso_id = c.id
   and a.lote_id = c.remanejamento_lote_id
   and a.protecao_ate = c.giro_fidelizacao_ate;
-- marcador sem marca (a marca saiu por troca de dono): so o marcador vai
update public.casos c set remanejamento_lote_id = null
 where c.remanejamento_lote_id is not null and c.giro_fidelizacao_ate is null;
do $rb$
declare v_src text; v_n int; v_md5 text;
begin
  -- ---- public.carteira_geral_previa
  select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'carteira_geral_previa';
  if v_src is null then raise exception 'rollback: public.carteira_geral_previa nao existe.'; end if;
  v_n := (length(v_src) - length(replace(v_src, $novo$    if v_destino_nome is null then
      raise exception 'Operador de destino invalido ou inativo: %', p_destino_email;
    end if;
    -- Destino recusado: inativo, sem recebimento de novos casos, ou vedado nesta operacao.
    if internal.cg_destino_recusado(v_destino_email) is not null then
      raise exception 'Destino recusado (%): %', internal.cg_destino_recusado(v_destino_email), v_destino_nome
        using errcode = '22023';
    end if;$novo$, ''))) / length($novo$    if v_destino_nome is null then
      raise exception 'Operador de destino invalido ou inativo: %', p_destino_email;
    end if;
    -- Destino recusado: inativo, sem recebimento de novos casos, ou vedado nesta operacao.
    if internal.cg_destino_recusado(v_destino_email) is not null then
      raise exception 'Destino recusado (%): %', internal.cg_destino_recusado(v_destino_email), v_destino_nome
        using errcode = '22023';
    end if;$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$    if v_destino_nome is null then
      raise exception 'Operador de destino invalido ou inativo: %', p_destino_email;
    end if;
    -- Destino recusado: inativo, sem recebimento de novos casos, ou vedado nesta operacao.
    if internal.cg_destino_recusado(v_destino_email) is not null then
      raise exception 'Destino recusado (%): %', internal.cg_destino_recusado(v_destino_email), v_destino_nome
        using errcode = '22023';
    end if;$novo$, $ancora$    if v_destino_nome is null then
      raise exception 'Operador de destino invalido ou inativo: %', p_destino_email;
    end if;$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$  -- Um unico responsavel por lote: o que esta filtrado na lista, nada mais.
  if coalesce(array_length(internal.cg_liberar_de(p_filtros),1),0) > 1
     or (internal.cg_liberar_de(p_filtros) is not null
         and array_length(internal.cg_liberar_de(p_filtros),1) = 1
         and lower(coalesce(p_filtros->>'responsavel',''))
             is distinct from (internal.cg_liberar_de(p_filtros))[1]) then
    raise exception 'A liberacao de fidelizacao vale para um unico responsavel: o que esta filtrado na lista.'
      using errcode = '22023';
  end if;
  -- P12: liberacao so para OPERADOR ATIVO (perfil operador, ativo). Carteira Geral (inativa), operador
  -- inativo e gerencia sao recusados ANTES de gravar a previa.
  if exists (select 1 from unnest(internal.cg_liberar_de(p_filtros)) x
              where not exists (select 1 from public.usuarios u
                                 where lower(u.email) = x and u.ativo and u.perfil = 'operador')) then
    raise exception 'A liberacao de fidelizacao so vale para operador ativo: %.',
      (select string_agg(x, ', ') from unnest(internal.cg_liberar_de(p_filtros)) x
        where not exists (select 1 from public.usuarios u
                           where lower(u.email) = x and u.ativo and u.perfil = 'operador'))
      using errcode = '22023';
  end if;
  if p_destino_tipo not in ('CARTEIRA_GERAL','OPERADOR','FILA_LIVRE') then$novo$, ''))) / length($novo$  -- Um unico responsavel por lote: o que esta filtrado na lista, nada mais.
  if coalesce(array_length(internal.cg_liberar_de(p_filtros),1),0) > 1
     or (internal.cg_liberar_de(p_filtros) is not null
         and array_length(internal.cg_liberar_de(p_filtros),1) = 1
         and lower(coalesce(p_filtros->>'responsavel',''))
             is distinct from (internal.cg_liberar_de(p_filtros))[1]) then
    raise exception 'A liberacao de fidelizacao vale para um unico responsavel: o que esta filtrado na lista.'
      using errcode = '22023';
  end if;
  -- P12: liberacao so para OPERADOR ATIVO (perfil operador, ativo). Carteira Geral (inativa), operador
  -- inativo e gerencia sao recusados ANTES de gravar a previa.
  if exists (select 1 from unnest(internal.cg_liberar_de(p_filtros)) x
              where not exists (select 1 from public.usuarios u
                                 where lower(u.email) = x and u.ativo and u.perfil = 'operador')) then
    raise exception 'A liberacao de fidelizacao so vale para operador ativo: %.',
      (select string_agg(x, ', ') from unnest(internal.cg_liberar_de(p_filtros)) x
        where not exists (select 1 from public.usuarios u
                           where lower(u.email) = x and u.ativo and u.perfil = 'operador'))
      using errcode = '22023';
  end if;
  if p_destino_tipo not in ('CARTEIRA_GERAL','OPERADOR','FILA_LIVRE') then$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$  -- Um unico responsavel por lote: o que esta filtrado na lista, nada mais.
  if coalesce(array_length(internal.cg_liberar_de(p_filtros),1),0) > 1
     or (internal.cg_liberar_de(p_filtros) is not null
         and array_length(internal.cg_liberar_de(p_filtros),1) = 1
         and lower(coalesce(p_filtros->>'responsavel',''))
             is distinct from (internal.cg_liberar_de(p_filtros))[1]) then
    raise exception 'A liberacao de fidelizacao vale para um unico responsavel: o que esta filtrado na lista.'
      using errcode = '22023';
  end if;
  -- P12: liberacao so para OPERADOR ATIVO (perfil operador, ativo). Carteira Geral (inativa), operador
  -- inativo e gerencia sao recusados ANTES de gravar a previa.
  if exists (select 1 from unnest(internal.cg_liberar_de(p_filtros)) x
              where not exists (select 1 from public.usuarios u
                                 where lower(u.email) = x and u.ativo and u.perfil = 'operador')) then
    raise exception 'A liberacao de fidelizacao so vale para operador ativo: %.',
      (select string_agg(x, ', ') from unnest(internal.cg_liberar_de(p_filtros)) x
        where not exists (select 1 from public.usuarios u
                           where lower(u.email) = x and u.ativo and u.perfil = 'operador'))
      using errcode = '22023';
  end if;
  if p_destino_tipo not in ('CARTEIRA_GERAL','OPERADOR','FILA_LIVRE') then$novo$, $ancora$  if p_destino_tipo not in ('CARTEIRA_GERAL','OPERADOR','FILA_LIVRE') then$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$    'itens', v_itens,
    'conflitos', v_conflitos,
    -- Remanejamento com fidelizacao: o que a execucao vai encontrar.
    'total_bloqueados', (select count(*)::int from jsonb_array_elements(v_itens) it
                          where nullif(it->>'bloqueio','') is not null),
    -- So informa a liberacao que tem efeito: dono liberado com caso fidelizado nesta previa.
    'liberar_fidelizacao_de', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
        from unnest(v_liberar) x
       where exists (select 1 from jsonb_array_elements(v_itens) it
                      where lower(coalesce(it->>'caso_de_email','')) = x
                        and nullif(it->>'caso_id','') is not null
                        and internal.cg_tem_fidelizacao((it->>'caso_id')::uuid))),
    'protecao_ate', case when p_destino_tipo = 'OPERADOR' then internal.cg_protecao_ate() end,
    'capacidade', case when p_destino_tipo = 'OPERADOR'
        then internal.cg_capacidade_sequencial(v_itens, v_destino_email) end
  ) into v_res;$novo$, ''))) / length($novo$    'itens', v_itens,
    'conflitos', v_conflitos,
    -- Remanejamento com fidelizacao: o que a execucao vai encontrar.
    'total_bloqueados', (select count(*)::int from jsonb_array_elements(v_itens) it
                          where nullif(it->>'bloqueio','') is not null),
    -- So informa a liberacao que tem efeito: dono liberado com caso fidelizado nesta previa.
    'liberar_fidelizacao_de', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
        from unnest(v_liberar) x
       where exists (select 1 from jsonb_array_elements(v_itens) it
                      where lower(coalesce(it->>'caso_de_email','')) = x
                        and nullif(it->>'caso_id','') is not null
                        and internal.cg_tem_fidelizacao((it->>'caso_id')::uuid))),
    'protecao_ate', case when p_destino_tipo = 'OPERADOR' then internal.cg_protecao_ate() end,
    'capacidade', case when p_destino_tipo = 'OPERADOR'
        then internal.cg_capacidade_sequencial(v_itens, v_destino_email) end
  ) into v_res;$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$    'itens', v_itens,
    'conflitos', v_conflitos,
    -- Remanejamento com fidelizacao: o que a execucao vai encontrar.
    'total_bloqueados', (select count(*)::int from jsonb_array_elements(v_itens) it
                          where nullif(it->>'bloqueio','') is not null),
    -- So informa a liberacao que tem efeito: dono liberado com caso fidelizado nesta previa.
    'liberar_fidelizacao_de', (select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
        from unnest(v_liberar) x
       where exists (select 1 from jsonb_array_elements(v_itens) it
                      where lower(coalesce(it->>'caso_de_email','')) = x
                        and nullif(it->>'caso_id','') is not null
                        and internal.cg_tem_fidelizacao((it->>'caso_id')::uuid))),
    'protecao_ate', case when p_destino_tipo = 'OPERADOR' then internal.cg_protecao_ate() end,
    'capacidade', case when p_destino_tipo = 'OPERADOR'
        then internal.cg_capacidade_sequencial(v_itens, v_destino_email) end
  ) into v_res;$novo$, $ancora$    'itens', v_itens,
    'conflitos', v_conflitos
  ) into v_res;$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$    union all
    -- Caso que NAO vai para o operador de destino, com o motivo. Um por caso.
    select jsonb_build_object(
             'tipo', 'BLOQUEADO_PARA_OPERADOR',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'motivo', it->>'bloqueio',
             'detalhe', 'Nao sera movido: '||internal.cg_bloqueio_texto(it->>'bloqueio')||'.')
      from jsonb_array_elements(v_itens) it
     where nullif(it->>'bloqueio','') is not null

    union all
    select jsonb_build_object(
             'tipo', 'CASO_ENCERRADO',$novo$, ''))) / length($novo$    union all
    -- Caso que NAO vai para o operador de destino, com o motivo. Um por caso.
    select jsonb_build_object(
             'tipo', 'BLOQUEADO_PARA_OPERADOR',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'motivo', it->>'bloqueio',
             'detalhe', 'Nao sera movido: '||internal.cg_bloqueio_texto(it->>'bloqueio')||'.')
      from jsonb_array_elements(v_itens) it
     where nullif(it->>'bloqueio','') is not null

    union all
    select jsonb_build_object(
             'tipo', 'CASO_ENCERRADO',$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$    union all
    -- Caso que NAO vai para o operador de destino, com o motivo. Um por caso.
    select jsonb_build_object(
             'tipo', 'BLOQUEADO_PARA_OPERADOR',
             'aluno_id', it->>'aluno_id', 'nome', it->>'nome',
             'motivo', it->>'bloqueio',
             'detalhe', 'Nao sera movido: '||internal.cg_bloqueio_texto(it->>'bloqueio')||'.')
      from jsonb_array_elements(v_itens) it
     where nullif(it->>'bloqueio','') is not null

    union all
    select jsonb_build_object(
             'tipo', 'CASO_ENCERRADO',$novo$, $ancora$    union all
    select jsonb_build_object(
             'tipo', 'CASO_ENCERRADO',$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$', acima do teto de '||v_teto||'. A execucao RECUSA os '||
                     (v_depois - v_teto)||' que nao cabem, do menor saldo para cima; nenhum caso que ja e de '||
                     v_destino_nome||' e solto.');$novo$, ''))) / length($novo$', acima do teto de '||v_teto||'. A execucao RECUSA os '||
                     (v_depois - v_teto)||' que nao cabem, do menor saldo para cima; nenhum caso que ja e de '||
                     v_destino_nome||' e solto.');$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$', acima do teto de '||v_teto||'. A execucao RECUSA os '||
                     (v_depois - v_teto)||' que nao cabem, do menor saldo para cima; nenhum caso que ja e de '||
                     v_destino_nome||' e solto.');$novo$, $ancora$', acima do teto de '||v_teto||'. O gatilho de teto vai soltar '||
                     (v_depois - v_teto)||' caso(s) para a fila livre, do menor valor para cima.');$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$      -- O MESMO contador do gatilho de teto (trg_impor_teto_operador): caso
      -- nao protegido e nao encerrado. Antes a previa contava todo caso nao
      -- encerrado, protegidos inclusive, e avisava de um estouro que a
      -- execucao nao via.
      v_carga := internal.cg_ocupacao_teto(v_destino_email);
      v_depois := v_carga + (select count(*)::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'bloqueio','') is null);$novo$, ''))) / length($novo$      -- O MESMO contador do gatilho de teto (trg_impor_teto_operador): caso
      -- nao protegido e nao encerrado. Antes a previa contava todo caso nao
      -- encerrado, protegidos inclusive, e avisava de um estouro que a
      -- execucao nao via.
      v_carga := internal.cg_ocupacao_teto(v_destino_email);
      v_depois := v_carga + (select count(*)::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'bloqueio','') is null);$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$      -- O MESMO contador do gatilho de teto (trg_impor_teto_operador): caso
      -- nao protegido e nao encerrado. Antes a previa contava todo caso nao
      -- encerrado, protegidos inclusive, e avisava de um estouro que a
      -- execucao nao via.
      v_carga := internal.cg_ocupacao_teto(v_destino_email);
      v_depois := v_carga + (select count(*)::int from jsonb_array_elements(v_itens) it
                              where nullif(it->>'bloqueio','') is null);$novo$, $ancora$      select count(*) into v_carga from public.casos c
       where lower(c.operador_email) = v_destino_email
         and not c.encerrado_operacional;
      v_depois := v_carga + jsonb_array_length(v_itens);$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$             c.encerrado_operacional as encerrado,
             -- Motivo que impede levar ESTE caso para um operador (nulo = pode).
             -- Congelado aqui; a execucao recalcula na hora e compara.
             internal.cg_bloqueio_remanejamento(c.id, p_destino_tipo, v_destino_email,
                                                v_liberar, coalesce(s.saldo_total,0)) as bloqueio,$novo$, ''))) / length($novo$             c.encerrado_operacional as encerrado,
             -- Motivo que impede levar ESTE caso para um operador (nulo = pode).
             -- Congelado aqui; a execucao recalcula na hora e compara.
             internal.cg_bloqueio_remanejamento(c.id, p_destino_tipo, v_destino_email,
                                                v_liberar, coalesce(s.saldo_total,0)) as bloqueio,$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$             c.encerrado_operacional as encerrado,
             -- Motivo que impede levar ESTE caso para um operador (nulo = pode).
             -- Congelado aqui; a execucao recalcula na hora e compara.
             internal.cg_bloqueio_remanejamento(c.id, p_destino_tipo, v_destino_email,
                                                v_liberar, coalesce(s.saldo_total,0)) as bloqueio,$novo$, $ancora$             c.encerrado_operacional as encerrado,$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$  v_sel uuid[] := coalesce(p_acordo_ids, '{}'::uuid[]);
  -- Remanejamento com fidelizacao (20261117150000): donos cuja fidelizacao
  -- vigente a gestao LIBERA de proposito neste lote. Vem em
  -- p_filtros.liberar_fidelizacao_de e fica gravado na previa.
  v_liberar text[] := internal.cg_liberar_de(p_filtros);$novo$, ''))) / length($novo$  v_sel uuid[] := coalesce(p_acordo_ids, '{}'::uuid[]);
  -- Remanejamento com fidelizacao (20261117150000): donos cuja fidelizacao
  -- vigente a gestao LIBERA de proposito neste lote. Vem em
  -- p_filtros.liberar_fidelizacao_de e fica gravado na previa.
  v_liberar text[] := internal.cg_liberar_de(p_filtros);$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_previa nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$  v_sel uuid[] := coalesce(p_acordo_ids, '{}'::uuid[]);
  -- Remanejamento com fidelizacao (20261117150000): donos cuja fidelizacao
  -- vigente a gestao LIBERA de proposito neste lote. Vem em
  -- p_filtros.liberar_fidelizacao_de e fica gravado na previa.
  v_liberar text[] := internal.cg_liberar_de(p_filtros);$novo$, $ancora$  v_sel uuid[] := coalesce(p_acordo_ids, '{}'::uuid[]);$ancora$);
  execute v_src;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'carteira_geral_previa';
  if v_md5 <> '774a8b340beb389706c66febc14db485' then
    raise exception 'rollback: public.carteira_geral_previa nao voltou ao corpo de producao (md5 %).', v_md5;
  end if;

  -- ---- public.carteira_geral_mover
  select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'carteira_geral_mover';
  if v_src is null then raise exception 'rollback: public.carteira_geral_mover nao existe.'; end if;
  v_n := (length(v_src) - length(replace(v_src, $novo$    'retornos_preservados', v_retornos,
    'protecao_ate', v_protecao_ate,
    'recusados_por_bloqueio_ou_teto', v_bloqueados,
    'ocupacao_final', v_ocup,
    'teto', v_teto,$novo$, ''))) / length($novo$    'retornos_preservados', v_retornos,
    'protecao_ate', v_protecao_ate,
    'recusados_por_bloqueio_ou_teto', v_bloqueados,
    'ocupacao_final', v_ocup,
    'teto', v_teto,$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$    'retornos_preservados', v_retornos,
    'protecao_ate', v_protecao_ate,
    'recusados_por_bloqueio_ou_teto', v_bloqueados,
    'ocupacao_final', v_ocup,
    'teto', v_teto,$novo$, $ancora$    'retornos_preservados', v_retornos,$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$         case when v_primeira then coalesce((it->>'saldo_acordo')::numeric,0) else 0 end,
         v_protecao_ate);$novo$, ''))) / length($novo$         case when v_primeira then coalesce((it->>'saldo_acordo')::numeric,0) else 0 end,
         v_protecao_ate);$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$         case when v_primeira then coalesce((it->>'saldo_acordo')::numeric,0) else 0 end,
         v_protecao_ate);$novo$, $ancora$         case when v_primeira then coalesce((it->>'saldo_acordo')::numeric,0) else 0 end);$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$         acordos_movidos, acordos_detalhe, valor_mensalidade, valor_acordo, protecao_ate)
      values$novo$, ''))) / length($novo$         acordos_movidos, acordos_detalhe, valor_mensalidade, valor_acordo, protecao_ate)
      values$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$         acordos_movidos, acordos_detalhe, valor_mensalidade, valor_acordo, protecao_ate)
      values$novo$, $ancora$         acordos_movidos, acordos_detalhe, valor_mensalidade, valor_acordo)
      values$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$'. Lote: '||v_lote::text||'. Agendamento de retorno preservado.'||
      case when v_protecao_ate is not null
           then ' Fidelizacao do novo responsavel ate '||to_char(v_protecao_ate,'DD/MM/YYYY')||'.'
           else '' end,$novo$, ''))) / length($novo$'. Lote: '||v_lote::text||'. Agendamento de retorno preservado.'||
      case when v_protecao_ate is not null
           then ' Fidelizacao do novo responsavel ate '||to_char(v_protecao_ate,'DD/MM/YYYY')||'.'
           else '' end,$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$'. Lote: '||v_lote::text||'. Agendamento de retorno preservado.'||
      case when v_protecao_ate is not null
           then ' Fidelizacao do novo responsavel ate '||to_char(v_protecao_ate,'DD/MM/YYYY')||'.'
           else '' end,$novo$, $ancora$'. Lote: '||v_lote::text||'. Agendamento de retorno preservado.',$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$     where aluno_id = r_al.aluno_id;

    -- Fidelizacao do novo responsavel: a marca de lote que ja existe
    -- (casos.giro_fidelizacao_ate), lida por caso_em_giro_fidelizacao. Em
    -- UPDATE separado e DEPOIS da troca de dono, de proposito: o gatilho
    -- trg_giro_limpar_marca apaga a marca quando o dono muda. Nao toca
    -- data_ultimo_acionamento, tabulacao, retorno nem historico.
    if v_previa.destino_tipo = 'OPERADOR' then
      update public.casos
         set giro_fidelizacao_ate = v_protecao_ate,
             remanejamento_lote_id = v_lote
       where aluno_id = r_al.aluno_id;
      v_ocup := v_ocup + v_n_casos;
    end if;

    if r_al.retorno_data is not null then$novo$, ''))) / length($novo$     where aluno_id = r_al.aluno_id;

    -- Fidelizacao do novo responsavel: a marca de lote que ja existe
    -- (casos.giro_fidelizacao_ate), lida por caso_em_giro_fidelizacao. Em
    -- UPDATE separado e DEPOIS da troca de dono, de proposito: o gatilho
    -- trg_giro_limpar_marca apaga a marca quando o dono muda. Nao toca
    -- data_ultimo_acionamento, tabulacao, retorno nem historico.
    if v_previa.destino_tipo = 'OPERADOR' then
      update public.casos
         set giro_fidelizacao_ate = v_protecao_ate,
             remanejamento_lote_id = v_lote
       where aluno_id = r_al.aluno_id;
      v_ocup := v_ocup + v_n_casos;
    end if;

    if r_al.retorno_data is not null then$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$     where aluno_id = r_al.aluno_id;

    -- Fidelizacao do novo responsavel: a marca de lote que ja existe
    -- (casos.giro_fidelizacao_ate), lida por caso_em_giro_fidelizacao. Em
    -- UPDATE separado e DEPOIS da troca de dono, de proposito: o gatilho
    -- trg_giro_limpar_marca apaga a marca quando o dono muda. Nao toca
    -- data_ultimo_acionamento, tabulacao, retorno nem historico.
    if v_previa.destino_tipo = 'OPERADOR' then
      update public.casos
         set giro_fidelizacao_ate = v_protecao_ate,
             remanejamento_lote_id = v_lote
       where aluno_id = r_al.aluno_id;
      v_ocup := v_ocup + v_n_casos;
    end if;

    if r_al.retorno_data is not null then$novo$, $ancora$     where aluno_id = r_al.aluno_id;

    if r_al.retorno_data is not null then$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$    -- Destino OPERADOR: elegibilidade, protecao de terceiros e vaga, na hora.
    if v_falha is null and v_previa.destino_tipo = 'OPERADOR' then
      select min(x.b), count(*)::int into v_bloq, v_n_casos
        from (select coalesce(
                       nullif(i.value->>'bloqueio',''),
                       internal.cg_bloqueio_remanejamento(
                         (i.value->>'caso_id')::uuid, 'OPERADOR', v_destino_email, v_liberar,
                         coalesce((select round(s.saldo_total,2) from public.calibragem_saldo_aluno s
                                    where s.aluno_id = r_al.aluno_id), 0))) as b
                from jsonb_array_elements(v_previa.itens) i
               where (i.value->>'aluno_id')::uuid = r_al.aluno_id) x;
      if v_bloq is not null then
        v_falha := internal.cg_bloqueio_texto(v_bloq);
        v_bloqueados := v_bloqueados + 1;
      elsif v_ocup + v_n_casos > v_teto then
        v_falha := 'sem vaga no teto de '||coalesce(v_destino_nome, v_destino_email)||
                   ' (teto '||v_teto||', ocupacao '||v_ocup||')';
        v_bloqueados := v_bloqueados + 1;
      end if;
    end if;

    if v_falha is not null then
      v_recusados := v_recusados || jsonb_build_object($novo$, ''))) / length($novo$    -- Destino OPERADOR: elegibilidade, protecao de terceiros e vaga, na hora.
    if v_falha is null and v_previa.destino_tipo = 'OPERADOR' then
      select min(x.b), count(*)::int into v_bloq, v_n_casos
        from (select coalesce(
                       nullif(i.value->>'bloqueio',''),
                       internal.cg_bloqueio_remanejamento(
                         (i.value->>'caso_id')::uuid, 'OPERADOR', v_destino_email, v_liberar,
                         coalesce((select round(s.saldo_total,2) from public.calibragem_saldo_aluno s
                                    where s.aluno_id = r_al.aluno_id), 0))) as b
                from jsonb_array_elements(v_previa.itens) i
               where (i.value->>'aluno_id')::uuid = r_al.aluno_id) x;
      if v_bloq is not null then
        v_falha := internal.cg_bloqueio_texto(v_bloq);
        v_bloqueados := v_bloqueados + 1;
      elsif v_ocup + v_n_casos > v_teto then
        v_falha := 'sem vaga no teto de '||coalesce(v_destino_nome, v_destino_email)||
                   ' (teto '||v_teto||', ocupacao '||v_ocup||')';
        v_bloqueados := v_bloqueados + 1;
      end if;
    end if;

    if v_falha is not null then
      v_recusados := v_recusados || jsonb_build_object($novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$    -- Destino OPERADOR: elegibilidade, protecao de terceiros e vaga, na hora.
    if v_falha is null and v_previa.destino_tipo = 'OPERADOR' then
      select min(x.b), count(*)::int into v_bloq, v_n_casos
        from (select coalesce(
                       nullif(i.value->>'bloqueio',''),
                       internal.cg_bloqueio_remanejamento(
                         (i.value->>'caso_id')::uuid, 'OPERADOR', v_destino_email, v_liberar,
                         coalesce((select round(s.saldo_total,2) from public.calibragem_saldo_aluno s
                                    where s.aluno_id = r_al.aluno_id), 0))) as b
                from jsonb_array_elements(v_previa.itens) i
               where (i.value->>'aluno_id')::uuid = r_al.aluno_id) x;
      if v_bloq is not null then
        v_falha := internal.cg_bloqueio_texto(v_bloq);
        v_bloqueados := v_bloqueados + 1;
      elsif v_ocup + v_n_casos > v_teto then
        v_falha := 'sem vaga no teto de '||coalesce(v_destino_nome, v_destino_email)||
                   ' (teto '||v_teto||', ocupacao '||v_ocup||')';
        v_bloqueados := v_bloqueados + 1;
      end if;
    end if;

    if v_falha is not null then
      v_recusados := v_recusados || jsonb_build_object($novo$, $ancora$    if v_falha is not null then
      v_recusados := v_recusados || jsonb_build_object($ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$    v_falha := null;

    -- Trava as linhas do aluno ate o fim do lote: acionamento, assuncao ou
    -- liberacao que chegue no meio espera, e a revalidacao abaixo enxerga o
    -- estado que vai de fato ser escrito. Caso antes da ficha, na mesma ordem
    -- de liberar_fidelizacao_caso.
    perform 1 from public.casos c where c.aluno_id = r_al.aluno_id order by c.id for update;
    perform 1 from public.alunos al where al.id = r_al.aluno_id for update;

    -- ---------------- revalidacao: TODOS os casos, um por um ----------------$novo$, ''))) / length($novo$    v_falha := null;

    -- Trava as linhas do aluno ate o fim do lote: acionamento, assuncao ou
    -- liberacao que chegue no meio espera, e a revalidacao abaixo enxerga o
    -- estado que vai de fato ser escrito. Caso antes da ficha, na mesma ordem
    -- de liberar_fidelizacao_caso.
    perform 1 from public.casos c where c.aluno_id = r_al.aluno_id order by c.id for update;
    perform 1 from public.alunos al where al.id = r_al.aluno_id for update;

    -- ---------------- revalidacao: TODOS os casos, um por um ----------------$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$    v_falha := null;

    -- Trava as linhas do aluno ate o fim do lote: acionamento, assuncao ou
    -- liberacao que chegue no meio espera, e a revalidacao abaixo enxerga o
    -- estado que vai de fato ser escrito. Caso antes da ficha, na mesma ordem
    -- de liberar_fidelizacao_caso.
    perform 1 from public.casos c where c.aluno_id = r_al.aluno_id order by c.id for update;
    perform 1 from public.alunos al where al.id = r_al.aluno_id for update;

    -- ---------------- revalidacao: TODOS os casos, um por um ----------------$novo$, $ancora$    v_falha := null;

    -- ---------------- revalidacao: TODOS os casos, um por um ----------------$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$  -- Destino OPERADOR: capacidade e protecao medidas AGORA, nao na previa.
  -- A trava por destino serializa dois lotes para a mesma pessoa -- sem ela os
  -- dois leriam a mesma ocupacao e somados passariam do teto.
  v_liberar := internal.cg_liberar_de(v_previa.filtros);
  if v_previa.destino_tipo = 'OPERADOR' then
    perform pg_advisory_xact_lock(hashtext('carteira_geral_mover:'||lower(v_destino_email)));
    if internal.cg_destino_recusado(v_destino_email) is not null then
      raise exception 'Destino recusado na execucao (%). Gere uma nova previa.',
        internal.cg_destino_recusado(v_destino_email) using errcode = '22023';
    end if;
    v_teto := public.calibragem_teto_operador(v_destino_email);
    v_ocup := internal.cg_ocupacao_teto(v_destino_email);
    v_protecao_ate := internal.cg_protecao_ate();
  end if;

  -- Laco por ALUNO, nao por item: a escrita sempre foi por aluno, e percorrer$novo$, ''))) / length($novo$  -- Destino OPERADOR: capacidade e protecao medidas AGORA, nao na previa.
  -- A trava por destino serializa dois lotes para a mesma pessoa -- sem ela os
  -- dois leriam a mesma ocupacao e somados passariam do teto.
  v_liberar := internal.cg_liberar_de(v_previa.filtros);
  if v_previa.destino_tipo = 'OPERADOR' then
    perform pg_advisory_xact_lock(hashtext('carteira_geral_mover:'||lower(v_destino_email)));
    if internal.cg_destino_recusado(v_destino_email) is not null then
      raise exception 'Destino recusado na execucao (%). Gere uma nova previa.',
        internal.cg_destino_recusado(v_destino_email) using errcode = '22023';
    end if;
    v_teto := public.calibragem_teto_operador(v_destino_email);
    v_ocup := internal.cg_ocupacao_teto(v_destino_email);
    v_protecao_ate := internal.cg_protecao_ate();
  end if;

  -- Laco por ALUNO, nao por item: a escrita sempre foi por aluno, e percorrer$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$  -- Destino OPERADOR: capacidade e protecao medidas AGORA, nao na previa.
  -- A trava por destino serializa dois lotes para a mesma pessoa -- sem ela os
  -- dois leriam a mesma ocupacao e somados passariam do teto.
  v_liberar := internal.cg_liberar_de(v_previa.filtros);
  if v_previa.destino_tipo = 'OPERADOR' then
    perform pg_advisory_xact_lock(hashtext('carteira_geral_mover:'||lower(v_destino_email)));
    if internal.cg_destino_recusado(v_destino_email) is not null then
      raise exception 'Destino recusado na execucao (%). Gere uma nova previa.',
        internal.cg_destino_recusado(v_destino_email) using errcode = '22023';
    end if;
    v_teto := public.calibragem_teto_operador(v_destino_email);
    v_ocup := internal.cg_ocupacao_teto(v_destino_email);
    v_protecao_ate := internal.cg_protecao_ate();
  end if;

  -- Laco por ALUNO, nao por item: a escrita sempre foi por aluno, e percorrer$novo$, $ancora$  -- Laco por ALUNO, nao por item: a escrita sempre foi por aluno, e percorrer$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$  v_primeira     boolean;
  -- Remanejamento com fidelizacao (20261117150000)
  v_liberar      text[];
  v_teto         int;
  v_ocup         int;
  v_n_casos      int;
  v_bloq         text;
  v_protecao_ate date;
  v_bloqueados   int := 0;
begin$novo$, ''))) / length($novo$  v_primeira     boolean;
  -- Remanejamento com fidelizacao (20261117150000)
  v_liberar      text[];
  v_teto         int;
  v_ocup         int;
  v_n_casos      int;
  v_bloq         text;
  v_protecao_ate date;
  v_bloqueados   int := 0;
begin$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$  v_primeira     boolean;
  -- Remanejamento com fidelizacao (20261117150000)
  v_liberar      text[];
  v_teto         int;
  v_ocup         int;
  v_n_casos      int;
  v_bloq         text;
  v_protecao_ate date;
  v_bloqueados   int := 0;
begin$novo$, $ancora$  v_primeira     boolean;
begin$ancora$);
  v_n := (length(v_src) - length(replace(v_src, $novo$     order by max(coalesce((i.value->>'saldo_total')::numeric,0)) desc,
              (i.value->>'aluno_id')::uuid
  loop$novo$, ''))) / length($novo$     order by max(coalesce((i.value->>'saldo_total')::numeric,0)) desc,
              (i.value->>'aluno_id')::uuid
  loop$novo$);
  if v_n <> 1 then raise exception 'rollback: public.carteira_geral_mover nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$     order by max(coalesce((i.value->>'saldo_total')::numeric,0)) desc,
              (i.value->>'aluno_id')::uuid
  loop$novo$, $ancora$     order by max(coalesce((i.value->>'saldo_total')::numeric,0)) desc
  loop$ancora$);
  execute v_src;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'carteira_geral_mover';
  if v_md5 <> 'a2223d068d8154258e5f1a8450911bea' then
    raise exception 'rollback: public.carteira_geral_mover nao voltou ao corpo de producao (md5 %).', v_md5;
  end if;

  -- ---- public.calibragem_executar_simulacao
  select pg_get_functiondef(p.oid) into v_src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'calibragem_executar_simulacao';
  if v_src is null then raise exception 'rollback: public.calibragem_executar_simulacao nao existe.'; end if;
  v_n := (length(v_src) - length(replace(v_src, $novo$    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    -- Lote recem remanejado ou girado tem fidelizacao propria (a marca
    -- giro_fidelizacao_ate): o nivelamento manual tambem nao o desfaz.
    and not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate);$novo$, ''))) / length($novo$    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    -- Lote recem remanejado ou girado tem fidelizacao propria (a marca
    -- giro_fidelizacao_ate): o nivelamento manual tambem nao o desfaz.
    and not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate);$novo$);
  if v_n <> 1 then raise exception 'rollback: public.calibragem_executar_simulacao nao tem o trecho da migration (% ocorrencias). A funcao mudou depois; nao reverto por cima.', v_n; end if;
  v_src := replace(v_src, $novo$    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    -- Lote recem remanejado ou girado tem fidelizacao propria (a marca
    -- giro_fidelizacao_ate): o nivelamento manual tambem nao o desfaz.
    and not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate);$novo$, $ancora$    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento);$ancora$);
  execute v_src;
  select md5(p.prosrc) into v_md5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'calibragem_executar_simulacao';
  if v_md5 <> '9f5ff16f64b5efbd4b0ae58b32c8bac6' then
    raise exception 'rollback: public.calibragem_executar_simulacao nao voltou ao corpo de producao (md5 %).', v_md5;
  end if;

end $rb$;

drop trigger if exists trg_cg_marcador_segue_a_marca on public.casos;
drop function if exists internal.cg_marcador_segue_a_marca();
drop function if exists internal.cg_destino_recusado(text);
drop function if exists internal.cg_capacidade_sequencial(jsonb, text);
drop function if exists internal.cg_bloqueio_remanejamento(uuid, text, text, text[], numeric);
drop function if exists internal.cg_bloqueio_texto(text);
drop function if exists internal.cg_ocupacao_teto(text);
drop function if exists internal.cg_tem_fidelizacao(uuid);
drop function if exists internal.cg_liberar_de(jsonb);
drop function if exists internal.cg_protecao_ate();

commit;
