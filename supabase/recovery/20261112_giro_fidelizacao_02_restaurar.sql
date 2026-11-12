-- ============================================================================
-- GIRO x FIDELIZAÇÃO · PASSO 2 · RESTAURAÇÃO POR ID (12/11/2026)
-- ----------------------------------------------------------------------------
-- NÃO EXECUTAR sem autorização expressa. Validado só em PGlite
-- (supabase/tests/fidelizacao_giro_lotes.test.js).
--
-- COMO USAR: `v_lote` = 1, 2 ou 3 restaura aquele lote; 0 restaura todos os
-- liberados. Devolve ao operador o aluno (caso e ficha) e repõe os campos que
-- a liberação zerou, a partir do retrato tirado no instante da liberação.
--
-- ORDEM DE REVERSÃO, IMPOSTA PELO SCRIPT:
--   1) o cron `fidelizacao_liberar_vencidos` continua PAUSADO (aborta se ativo);
--   2) rollback da migration 20261112210000 (aborta se a regra nova ainda
--      estiver no ar -- ver `v_exigir_regra_antiga`);
--   3) este script;
--   4) só então reativar o cron.
-- Restaurar com a regra nova e o cron ativo faria o cron soltar tudo de novo no
-- dia seguinte.
--
-- A UNIDADE É O ALUNO (como na liberação): devolver o dono em um caso propaga,
-- por gatilho, a todos os casos do mesmo aluno.
--
-- CADA ALUNO É INDEPENDENTE. Um aluno que não pode voltar NÃO derruba os
-- outros: ele é pulado, o motivo fica gravado e ele pode ser tentado de novo.
--   nao_restaurado_ja_tem_dono                 alguém assumiu, ou o aluno ganhou caso novo;
--   nao_restaurado_mudou_depois_da_liberacao   status, tabulação ou acionamento mudaram, ou
--                                              um operador marcou retorno: houve trabalho
--                                              depois de solto; a gestão decide caso a caso;
--   falhou: ...                                erro ou conferência reprovada; o aluno fica
--                                              exatamente como estava (subtransação).
--
-- CONFERÊNCIA, POR ALUNO: depois de escrever, compara com o retrato TODOS os
-- campos que a restauração escreve -- operador de cada caso, marca do giro,
-- responsável, data da responsabilidade, retorno, hora, próxima ação, origem e
-- confirmação do retorno. Divergiu, o aluno é desfeito.
--
-- O histórico (movimentações, `audit_log`, `historico_operadores_alunos`) é
-- só-acréscimo: as linhas da liberação ficam; a restauração acrescenta a sua.
-- ============================================================================
begin;
set local statement_timeout = '300s';
set local lock_timeout = '5s';
-- Devolver o dono nao pode disparar a rotina de teto (o operador pode ficar
-- acima do teto por exigencia da restauracao). Vale so nesta transacao.
select set_config('calibragem.bypass_teto', 'on', true);

do $rest$
declare
  v_lote int := 0; -- <<< 0 = todos os liberados; 1, 2 ou 3 = so aquele lote
  v_exigir_regra_antiga boolean := true; -- <<< false SO com decisao expressa da gestao: restaura mantendo a regra nova (o cron tem de continuar pausado)
  u record;
  r record;
  v_n int;
  v_cnt int;
  v_motivo text;
  v_ok int := 0;       -- casos restaurados
  v_alunos int := 0;
  v_pulo_dono int := 0;
  v_pulo_mudou int := 0;
  v_falha int := 0;
begin
  if v_lote not in (0, 1, 2, 3) then
    raise exception 'restaurar: v_lote tem de ser 0, 1, 2 ou 3 (veio %).', v_lote;
  end if;
  if to_regclass('public._backup_fidelizacao_giro_20261112') is null then
    raise exception 'restaurar: backup inexistente.';
  end if;

  -- TRAVAS DE ORDEM.
  if to_regclass('cron.job') is null then
    raise exception 'restaurar: cron.job nao existe; nao da para conferir que o cron esta pausado.';
  end if;
  execute $q$select count(*) from cron.job where jobname = 'fidelizacao_liberar_vencidos' and not active$q$ into v_n;
  if v_n <> 1 then
    raise exception 'restaurar: o cron fidelizacao_liberar_vencidos esta ATIVO ou ausente; pause antes. Ativo, ele soltaria de novo o que for restaurado.';
  end if;
  -- falha FECHADA: o job tem de existir com este nome e estar pausado (ou nao ativo)
  execute $q$select count(*) from cron.job where jobname = 'reposicao_carteira_minuto'$q$ into v_n;
  if v_n <> 1 then
    raise exception 'lote: o job reposicao_carteira_minuto nao foi encontrado pelo nome; nao da para garantir que ele esta pausado.';
  end if;
  execute $q$select count(*) from cron.job where jobname = 'reposicao_carteira_minuto' and active$q$ into v_n;
  if v_n > 0 then
    raise exception 'restaurar: o cron de reposicao de carteira esta ATIVO.';
  end if;
  if v_exigir_regra_antiga
     and position('caso_em_giro_fidelizacao(v_c.giro_fidelizacao_ate)' in
           pg_get_functiondef('public.liberar_fidelizacao_caso(uuid,text,text)'::regprocedure)) > 0 then
    raise exception 'restaurar: a regra nova ainda esta no ar. Faca antes o rollback da migration 20261112210000 (ou, com decisao expressa, v_exigir_regra_antiga := false).';
  end if;

  for u in
    select b.unidade, (array_agg(b.aluno_id))[1] as aluno_id
      from public._backup_fidelizacao_giro_20261112 b
     where b.liberado_em is not null and b.restaurado_em is null
       and (v_lote = 0 or b.lote = v_lote)
     group by b.unidade order by b.unidade
  loop
    v_motivo := null;
    v_n := 0;
    begin  -- subtransacao: o que falhar aqui desfaz so este aluno
      perform 1 from public.casos c
        where c.aluno_id = u.aluno_id
           or c.id in (select b.caso_id from public._backup_fidelizacao_giro_20261112 b where b.unidade = u.unidade)
        for update;
      perform 1 from public.alunos a where a.id = u.aluno_id for update;

      select b.* into r from public._backup_fidelizacao_giro_20261112 b
       where b.unidade = u.unidade and b.tipo = 'ALVO' order by b.caso_id limit 1;

      -- 1. so volta o aluno que continua INTEIRO sem dono e sem caso novo
      if exists (select 1 from public.alunos a where a.id = u.aluno_id and a.responsavel_atual_email is not null)
         or exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                     join public.casos c on c.id = b.caso_id
                    where b.unidade = u.unidade and c.operador_email is not null)
         or exists (select 1 from public.casos c
                     where c.aluno_id = u.aluno_id
                       and not exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                                        where b.caso_id = c.id and b.unidade = u.unidade)) then
        v_motivo := 'nao_restaurado_ja_tem_dono';

      -- 2. ...e em quem ninguem trabalhou depois de solto. Campos que a
      --    restauracao NAO escreve: se mudaram, houve atividade. ('' = nulo:
      --    a liberacao transforma status_acionamento vazio em nulo.)
      elsif exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                     join public.casos c on c.id = b.caso_id
                    where b.unidade = u.unidade
                      and ( nullif(btrim(c.status_atual), '') is distinct from nullif(btrim(b.caso_status_atual), '')
                         or nullif(btrim(c.status_acionamento), '') is distinct from nullif(btrim(b.caso_status_acionamento), '')
                         or nullif(btrim(c.status_financeiro), '') is distinct from nullif(btrim(b.caso_status_financeiro), '')
                         or c.data_ultimo_acionamento is distinct from b.caso_data_ultimo_acionamento ))
         or exists (select 1 from public.alunos a
                     where a.id = u.aluno_id
                       and ( nullif(btrim(a.status_atual), '') is distinct from nullif(btrim(r.aluno_status_atual), '')
                          or nullif(btrim(a.status_jornada), '') is distinct from nullif(btrim(r.aluno_status_jornada), '')
                          or nullif(btrim(a.status_acionamento), '') is distinct from nullif(btrim(r.aluno_status_acionamento), '')
                          or a.data_ultimo_acionamento is distinct from r.aluno_data_ultimo_acionamento
                          -- retorno marcado por pessoa depois de solto e compromisso novo
                          or (a.data_retorno is not null and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%') )) then
        v_motivo := 'nao_restaurado_mudou_depois_da_liberacao';
      end if;

      if v_motivo is null then
        -- a) devolve o dono no primeiro caso ALVO; a cadeia de gatilhos propaga
        --    ao aluno e, dele, a todos os casos do mesmo aluno.
        update public.casos
           set operador_email = r.operador_email, operador_nome = r.operador_nome,
               operador = r.operador,
               caso_atualizado_por = 'restauracao_giro_fidelizacao', caso_atualizado_em = now()
         where id = r.caso_id and operador_email is null;
        get diagnostics v_cnt = row_count;
        if v_cnt <> 1 then
          raise exception 'o primeiro caso nao estava livre no momento da escrita';
        end if;

        -- b) garante os demais casos do backup (caso sem aluno nao tem cascata).
        update public.casos c
           set operador_email = b.operador_email, operador_nome = b.operador_nome, operador = b.operador
          from public._backup_fidelizacao_giro_20261112 b
         where b.caso_id = c.id and b.unidade = u.unidade and c.operador_email is null;

        -- c) repoe a marca do giro em cada caso (o gatilho a limpou ao trocar o dono).
        update public.casos c
           set giro_fidelizacao_ate = b.caso_giro_fidelizacao_ate
          from public._backup_fidelizacao_giro_20261112 b
         where b.caso_id = c.id and b.unidade = u.unidade
           and c.giro_fidelizacao_ate is distinct from b.caso_giro_fidelizacao_ate;

        -- d) repoe o que a troca de dono zerou no ALUNO. status_acionamento e
        --    data_ultimo_acionamento NAO entram: a liberacao nao os apaga.
        if u.aluno_id is not null then
          update public.alunos
             set responsavel_atual_em = r.resp_em,
                 proxima_acao = r.aluno_proxima_acao,
                 data_retorno = r.aluno_data_retorno,
                 hora_retorno = r.aluno_hora_retorno,
                 retorno_origem = r.aluno_retorno_origem
           where id = u.aluno_id;
          -- a confirmacao do retorno e zerada por gatilho quando a data muda; repoe depois.
          update public.alunos set retorno_confirmado_em = r.aluno_retorno_confirmado_em
           where id = u.aluno_id and retorno_confirmado_em is distinct from r.aluno_retorno_confirmado_em;
        end if;

        -- CONFERENCIA do que foi escrito, contra o retrato.
        if exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                    join public.casos c on c.id = b.caso_id
                   where b.unidade = u.unidade
                     and ( lower(c.operador_email) is distinct from lower(b.operador_email)
                        or c.giro_fidelizacao_ate is distinct from b.caso_giro_fidelizacao_ate ))
           or exists (select 1 from public.alunos a
                       where a.id = u.aluno_id
                         and ( lower(a.responsavel_atual_email) is distinct from lower(r.resp_email)
                            or a.responsavel_atual_em is distinct from r.resp_em
                            or a.proxima_acao is distinct from r.aluno_proxima_acao
                            or a.data_retorno is distinct from r.aluno_data_retorno
                            or nullif(a.hora_retorno, '') is distinct from nullif(r.aluno_hora_retorno, '')
                            or a.retorno_origem is distinct from r.aluno_retorno_origem
                            or a.retorno_confirmado_em is distinct from r.aluno_retorno_confirmado_em
                            -- cascata de gatilhos que muda acionamento ou status ao devolver: pega aqui
                            or a.status_jornada is distinct from r.aluno_status_jornada
                            or a.data_ultimo_acionamento is distinct from r.aluno_data_ultimo_acionamento )) then
          raise exception 'conferencia: o estado restaurado difere do retrato';
        end if;

        insert into public.historico_operadores_alunos
          (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_nome, operador_email, observacao, criado_em)
        select c.chave_unificacao, c.nome, c.cpf, 'RESTAURACAO_FIDELIZACAO_GIRO', b.operador_nome, b.operador_email,
               'Restauracao por id do backup _backup_fidelizacao_giro_20261112 (lote ' || b.lote || ').', now()
          from public._backup_fidelizacao_giro_20261112 b
          join public.casos c on c.id = b.caso_id
         where b.unidade = u.unidade;

        update public._backup_fidelizacao_giro_20261112
           set restaurado_em = now(), restaurado_motivo = 'restaurado' where unidade = u.unidade;
        get diagnostics v_n = row_count;
      end if;
    exception
      when insufficient_privilege then raise;
      when others then
        v_motivo := 'falhou: ' || left(sqlerrm, 200);
    end;

    if v_motivo is null then
      v_ok := v_ok + v_n;
      v_alunos := v_alunos + 1;
    else
      -- restaurado_em fica nulo: o aluno pode ser tentado de novo depois.
      update public._backup_fidelizacao_giro_20261112
         set restaurado_motivo = v_motivo where unidade = u.unidade;
      if v_motivo = 'nao_restaurado_ja_tem_dono' then v_pulo_dono := v_pulo_dono + 1;
      elsif v_motivo = 'nao_restaurado_mudou_depois_da_liberacao' then v_pulo_mudou := v_pulo_mudou + 1;
      else v_falha := v_falha + 1;
      end if;
    end if;
  end loop;

  raise notice 'RESTAURACAO (lote %): alunos_restaurados=% casos_restaurados=% pulados_ja_tem_dono=% pulados_mudou_depois=% falhas=%',
    v_lote, v_alunos, v_ok, v_pulo_dono, v_pulo_mudou, v_falha;
end
$rest$;

select b.lote, split_part(b.operador_email, '@', 1) operador,
       count(*) filter (where b.liberado_em is not null) liberados,
       count(*) filter (where b.restaurado_motivo = 'restaurado') restaurados,
       count(*) filter (where b.liberado_em is not null and b.restaurado_em is null) nao_restaurados
  from public._backup_fidelizacao_giro_20261112 b
 group by rollup (b.lote, split_part(b.operador_email, '@', 1))
 order by 1 nulls last, 2 nulls last;

select b.restaurado_motivo, count(*) casos
  from public._backup_fidelizacao_giro_20261112 b
 where b.liberado_em is not null and b.restaurado_em is null group by 1 order by 2 desc;

commit;
