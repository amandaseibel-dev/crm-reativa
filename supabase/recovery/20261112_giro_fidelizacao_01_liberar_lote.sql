-- ============================================================================
-- GIRO x FIDELIZAÇÃO · PASSO 1 · LIBERAR UM LOTE (12/11/2026)
-- ----------------------------------------------------------------------------
-- NÃO EXECUTAR sem autorização expressa. Validado só em PGlite
-- (supabase/tests/fidelizacao_giro_lotes.test.js).
--
-- COMO USAR: troque UMA linha, `v_lote`, para 1, 2 ou 3 e rode. Um lote por
-- execução, em ordem. Confira o resultado antes de rodar o seguinte.
--
-- POR QUE O LOTE É CONTROLÁVEL: só os ALUNOS do backup daquele lote são
-- tocados, um a um, por `liberar_fidelizacao_caso`. Nada aqui chama
-- `liberar_casos_fidelizacao_vencida`, que soltaria todos os elegíveis.
--
-- A UNIDADE É O ALUNO: soltar um caso solta por gatilho todos os casos do mesmo
-- aluno. O lote libera o primeiro caso ALVO do aluno e CONFERE que todos os
-- casos dele registrados no backup (ALVO e ARRASTO) ficaram sem operador.
-- Linhas RETIDO nunca são tocadas.
--
-- TRAVAS DE ENTRADA (abortam a transação inteira, sem solto nenhum):
--   1. o cron `fidelizacao_liberar_vencidos` tem de estar PAUSADO (ativo, ele
--      soltaria os lotes seguintes às 05:20) e o de reposição não pode estar ativo;
--   2. os lotes anteriores têm de estar concluídos; o lote não pode já ter rodado;
--   3. a data do banco (UTC) tem de ser a de São Paulo (entre 21h e 24h BRT o
--      10º dia contaria como 11º).
--
-- POR ALUNO (falhou, o aluno inteiro é PULADO e registrado; os demais seguem):
--   a. as linhas do aluno e dos casos dele são travadas (`for update`);
--   b. todos os casos ALVO têm de estar na lista de elegíveis tirada no início
--      E passar de novo, na hora, por cada proteção: mesmo operador, não
--      protegido, não encerrado, não congelado, fora dos 10 dias, sem giro
--      vigente, fora do hold de 24h, sem retorno marcado pelo operador;
--   c. o aluno não pode ter ganho caso fora do backup;
--   d. os casos ARRASTO têm de seguir encerrados, fora dos 10 dias, não
--      congelados, não protegidos e do mesmo operador;
--   e. erro em um aluno (gatilho, dado inesperado) desfaz só aquele aluno.
--   A revalidação reduz, mas não elimina, a janela entre conferir e soltar:
--   proteção criada em OUTRA tabela (acordo, pagamento) no mesmo instante não
--   é travada. Por isso a execução é fora do expediente.
--
-- RETRATO NO INSTANTE: imediatamente antes de soltar, o estado do caso e do
-- aluno é REGRAVADO no backup. É esse retrato que a restauração devolve.
--
-- INVARIANTE DE SAÍDA, POR LISTA DE IDS (aborta e desfaz o lote inteiro):
--   * todo caso que ficou sem operador nesta execução tem de estar na lista do
--     que o lote liberou -- nem um a mais;
--   * todo caso que o lote liberou tem de estar sem operador;
--   * nenhum caso que estava sem operador pode ter ganho dono (a liberação não
--     entrega caso a ninguém). Se alguém assumir um caso durante a execução, o
--     lote aborta por segurança: basta rodar de novo.
--
-- O QUE A LIBERAÇÃO FAZ: o caso e o aluno ficam sem responsável; acionamento e
-- tabulação são preservados; `proxima_acao`, `data_retorno`, `hora_retorno` e
-- `retorno_origem` do aluno são ZERADOS pela cadeia casos ->
-- trg_sync_alunos_apos_casos -> internal.set_resp_aluno.
-- ============================================================================
begin;
set local statement_timeout = '300s';
-- Quem estiver segurando uma linha (operador tabulando) NAO pode prender o lote:
-- espera 5 s e o aluno e pulado; nao espera 300 s.
set local lock_timeout = '5s';

do $lote$
declare
  v_lote int := 1; -- <<< LOTE (1, 2 ou 3): UNICA LINHA A TROCAR
  r record;
  v_n int;
  v_total int;
  v_ok int := 0;        -- CASOS liberados (alvo + arrasto)
  v_alunos int := 0;    -- alunos liberados
  v_pulados int := 0;   -- alunos pulados na revalidacao
  v_erros int := 0;     -- alunos pulados por erro
  v_motivo text;
  v_primeiro uuid;
  v_extra int;
  v_falta int;
  v_ganhou int;
  v_troca int;
  v_exist int;
begin
  if v_lote not in (1, 2, 3) then
    raise exception 'lote: v_lote tem de ser 1, 2 ou 3 (veio %).', v_lote;
  end if;
  if current_date <> (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'lote: a data do banco (%) nao e a de Sao Paulo (%). Rode antes das 21h ou depois da meia-noite (BRT).',
      current_date, (now() at time zone 'America/Sao_Paulo')::date;
  end if;
  if to_regclass('public._backup_fidelizacao_giro_20261112') is null then
    raise exception 'lote: backup inexistente; rode o passo 0.';
  end if;

  -- TRAVA 1: crons.
  if to_regclass('cron.job') is null then
    raise exception 'lote: cron.job nao existe; nao da para conferir que o cron esta pausado.';
  end if;
  execute $q$select count(*) from cron.job where jobname = 'fidelizacao_liberar_vencidos' and not active$q$ into v_n;
  if v_n <> 1 then
    raise exception 'lote: o cron fidelizacao_liberar_vencidos esta ATIVO ou ausente; pause antes. Ativo, ele solta os outros lotes sozinho.';
  end if;
  -- falha FECHADA: o job tem de existir com este nome e estar pausado (ou nao ativo)
  execute $q$select count(*) from cron.job where jobname = 'reposicao_carteira_minuto'$q$ into v_n;
  if v_n <> 1 then
    raise exception 'lote: o job reposicao_carteira_minuto nao foi encontrado pelo nome; nao da para garantir que ele esta pausado.';
  end if;
  execute $q$select count(*) from cron.job where jobname = 'reposicao_carteira_minuto' and active$q$ into v_n;
  if v_n > 0 then
    raise exception 'lote: o cron de reposicao de carteira esta ATIVO; ele redistribuiria os casos soltos.';
  end if;

  -- TRAVA 2: ordem e unicidade.
  if exists (select 1 from public._backup_fidelizacao_giro_20261112 b
              where b.lote < v_lote and b.tipo <> 'RETIDO' and b.liberado_em is null and b.pulado_motivo is null) then
    raise exception 'lote: ha lote anterior ao % nao concluido.', v_lote;
  end if;
  if exists (select 1 from public._backup_fidelizacao_giro_20261112 b
              where b.lote = v_lote and b.tipo <> 'RETIDO' and (b.liberado_em is not null or b.pulado_motivo is not null)) then
    raise exception 'lote: o lote % ja foi executado.', v_lote;
  end if;

  select count(*) into v_total from public._backup_fidelizacao_giro_20261112 where lote = v_lote and tipo = 'ALVO';
  if v_total = 0 then
    raise exception 'lote: o lote % esta vazio no backup.', v_lote;
  end if;

  create temp table _elegiveis_agora on commit drop as
    select e.caso_id from public.casos_elegiveis_liberacao_fidelizacao() e;
  create temp table _sem_dono_antes on commit drop as
    select c.id from public.casos c where c.operador_email is null;
  create temp table _liberados_agora (caso_id uuid primary key) on commit drop;
  create temp table _dono_antes on commit drop as
    select c.id, c.operador_email as email from public.casos c;

  for r in
    select distinct b.unidade from public._backup_fidelizacao_giro_20261112 b
     where b.lote = v_lote and b.tipo = 'ALVO' order by b.unidade
  loop
    v_motivo := null;
    v_n := 0;
    begin  -- subtransacao: erro aqui desfaz so este aluno
      -- a. trava as linhas do aluno e de todos os casos dele
      perform 1 from public.casos c
        where c.aluno_id = r.unidade
           or c.id in (select b.caso_id from public._backup_fidelizacao_giro_20261112 b where b.unidade = r.unidade)
        for update;
      perform 1 from public.alunos a where a.id = r.unidade for update;

      -- b. ALVO: elegivel no inicio E ainda agora, protecao por protecao
      if exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                  where b.unidade = r.unidade and b.tipo = 'ALVO'
                    and not exists (select 1 from _elegiveis_agora x where x.caso_id = b.caso_id)) then
        v_motivo := 'nao_elegivel_na_execucao';
      elsif exists (
        select 1 from public._backup_fidelizacao_giro_20261112 b
          join public.casos c on c.id = b.caso_id
          left join public.alunos a on a.id = c.aluno_id
         where b.unidade = r.unidade and b.tipo = 'ALVO'
           and ( lower(c.operador_email) is distinct from lower(b.operador_email)
              or public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
                    c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
              or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                    c.status_financeiro, c.status_jornada)
              or public.caso_encerramento_congelado(c.id)
              or public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
              or public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)
              or not (coalesce(a.responsavel_atual_em, c.caso_atualizado_em, now() - interval '2 days')
                        < now() - interval '1 day')
              or (a.data_retorno >= (now() at time zone 'America/Sao_Paulo')::date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%') )) then
        v_motivo := 'ganhou_protecao_desde_o_inicio';
      -- c. o aluno nao ganhou caso fora do backup
      elsif exists (select 1 from public.casos c
                     where c.aluno_id = r.unidade
                       and not exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                                        where b.caso_id = c.id and b.unidade = r.unidade)) then
        v_motivo := 'aluno_ganhou_caso_fora_do_backup';
      -- d. os ARRASTO seguem podendo sair
      elsif exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                     join public.casos c on c.id = b.caso_id
                    where b.unidade = r.unidade and b.tipo = 'ARRASTO'
                      and (lower(c.operador_email) is distinct from lower(b.operador_email)
                           or public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
                           or public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)
                           or public.caso_encerramento_congelado(c.id)
                           or public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
                                 c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
                           or not (coalesce(c.encerrado_operacional, false)
                                   or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                                        c.status_financeiro, c.status_jornada)))) then
        v_motivo := 'arrasto_mudou_desde_o_backup';
      end if;

      if v_motivo is null then
        -- RETRATO NO INSTANTE: e este estado que a restauracao devolve.
        update public._backup_fidelizacao_giro_20261112 b
           set operador_email = c.operador_email, operador_nome = c.operador_nome, operador = c.operador,
               caso_status_atual = c.status_atual, caso_status_acionamento = c.status_acionamento,
               caso_status_financeiro = c.status_financeiro,
               caso_data_ultimo_acionamento = c.data_ultimo_acionamento,
               caso_giro_fidelizacao_ate = c.giro_fidelizacao_ate,
               resp_email = a.responsavel_atual_email, resp_nome = a.responsavel_atual_nome,
               resp_em = a.responsavel_atual_em,
               aluno_status_atual = a.status_atual, aluno_status_jornada = a.status_jornada,
               aluno_status_acionamento = a.status_acionamento,
               aluno_data_ultimo_acionamento = a.data_ultimo_acionamento,
               aluno_proxima_acao = a.proxima_acao, aluno_data_retorno = a.data_retorno,
               aluno_hora_retorno = a.hora_retorno, aluno_retorno_origem = a.retorno_origem,
               aluno_retorno_confirmado_em = a.retorno_confirmado_em,
               aluno_nivel_criticidade = a.nivel_criticidade,
               retrato_em = clock_timestamp()
          from public.casos c
          left join public.alunos a on a.id = c.aluno_id
         where c.id = b.caso_id and b.unidade = r.unidade;

        select b.caso_id into v_primeiro from public._backup_fidelizacao_giro_20261112 b
         where b.unidade = r.unidade and b.tipo = 'ALVO' order by b.caso_id limit 1;

        if not public.liberar_fidelizacao_caso(v_primeiro, 'FIDELIZACAO_EXPIRADA',
                  'giro_fidelizacao_lote_' || v_lote) then
          v_motivo := 'funcao_recusou';
        else
          if exists (select 1 from public._backup_fidelizacao_giro_20261112 b
                      join public.casos c on c.id = b.caso_id
                     where b.unidade = r.unidade and c.operador_email is not null) then
            raise exception 'ficou com caso ainda atribuido depois da liberacao (cascata diferente da medida)';
          end if;

          -- historico dos casos que sairam junto (o primeiro ja foi gravado pela funcao)
          insert into public.historico_operadores_alunos
            (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em)
          select c.chave_unificacao, c.nome, c.cpf, 'FIDELIZACAO_EXPIRADA', b.operador_nome, b.operador_email,
                 'Liberado junto com o caso ' || v_primeiro::text || ' do mesmo aluno (lote ' || v_lote || '). Caso LIVRE, sem atribuicao automatica.', now()
            from public._backup_fidelizacao_giro_20261112 b
            join public.casos c on c.id = b.caso_id
           where b.unidade = r.unidade and b.caso_id <> v_primeiro;

          update public._backup_fidelizacao_giro_20261112
             set liberado_em = now(),
                 liberado_por = 'giro_fidelizacao_lote_' || v_lote || case when caso_id = v_primeiro then '' else '_arrasto' end
           where unidade = r.unidade;
          get diagnostics v_n = row_count;

          insert into _liberados_agora (caso_id)
          select b.caso_id from public._backup_fidelizacao_giro_20261112 b where b.unidade = r.unidade;
        end if;
      end if;
    exception
      when insufficient_privilege then raise;   -- quem nao pode rodar nao marca nada
      when others then
        v_motivo := 'erro: ' || left(sqlerrm, 200);
        v_erros := v_erros + 1;
    end;

    if v_motivo is not null then
      update public._backup_fidelizacao_giro_20261112
         set pulado_motivo = v_motivo where unidade = r.unidade;
      v_pulados := v_pulados + 1;
    else
      v_ok := v_ok + v_n;
      v_alunos := v_alunos + 1;
    end if;
  end loop;

  if v_alunos = 0 and v_erros > 0 then
    raise exception 'lote: nenhum aluno liberado e % erro(s). Lote desfeito; nada foi marcado.', v_erros;
  end if;

  -- LIMITE DE ERROS: se mais de 10% dos alunos tentados falharam, o lote nao e
  -- confiavel -- algo esta fora do previsto. Desfaz tudo.
  if v_erros > 0 and v_erros * 10 > (v_alunos + v_erros) then
    raise exception 'lote: % de % alunos com erro (acima de 10%%). Lote desfeito; nada foi marcado.', v_erros, v_alunos + v_erros;
  end if;

  -- INVARIANTE POR LISTA DE IDS.
  -- Troca de dono de um operador para OUTRO (X -> Y) tambem e detectada: nenhum caso
  -- fora da lista pode mudar de dono nesta execucao.
  select count(*) into v_troca from _dono_antes d
    join public.casos c on c.id = d.id
   where d.email is not null and c.operador_email is not null
     and c.operador_email is distinct from d.email
     and not exists (select 1 from _liberados_agora l where l.caso_id = d.id);
  select count(*) into v_extra from public.casos c
   where c.operador_email is null
     and not exists (select 1 from _sem_dono_antes s where s.id = c.id)
     and not exists (select 1 from _liberados_agora l where l.caso_id = c.id);
  select count(*) into v_falta from _liberados_agora l
    join public.casos c on c.id = l.caso_id where c.operador_email is not null;
  select count(*) into v_ganhou from _sem_dono_antes s
    join public.casos c on c.id = s.id where c.operador_email is not null;
  if v_extra > 0 or v_falta > 0 or v_ganhou > 0 or v_troca > 0 then
    raise exception 'lote: INVARIANTE violada. soltos_fora_da_lista=% liberados_ainda_com_dono=% livres_que_ganharam_dono=% trocas_de_dono_fora_da_lista=%. Lote desfeito.',
      v_extra, v_falta, v_ganhou, v_troca;
  end if;

  raise notice 'LOTE % concluido: casos_alvo_no_backup=% alunos_liberados=% casos_liberados(alvo+arrasto)=% alunos_pulados=% (por erro=%)',
    v_lote, v_total, v_alunos, v_ok, v_pulados, v_erros;
end
$lote$;

-- Resultado (le o proprio backup).
select b.lote, split_part(b.operador_email, '@', 1) operador,
       count(*) filter (where b.tipo <> 'RETIDO') no_lote,
       count(*) filter (where b.liberado_em is not null and b.tipo = 'ALVO') liberados_alvo,
       count(*) filter (where b.liberado_em is not null and b.tipo = 'ARRASTO') liberados_arrasto,
       count(*) filter (where b.pulado_motivo is not null and b.tipo <> 'RETIDO') pulados,
       count(*) filter (where b.tipo = 'RETIDO') retidos_fora_do_lote,
       count(*) filter (where b.liberado_em is null and b.pulado_motivo is null) pendentes
  from public._backup_fidelizacao_giro_20261112 b
 group by rollup (b.lote, split_part(b.operador_email, '@', 1))
 order by 1 nulls last, 2 nulls last;

select b.pulado_motivo, count(*) casos
  from public._backup_fidelizacao_giro_20261112 b
 where b.pulado_motivo is not null group by 1 order by 2 desc;

commit;
