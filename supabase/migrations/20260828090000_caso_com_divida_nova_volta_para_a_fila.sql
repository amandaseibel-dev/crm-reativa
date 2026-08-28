-- Espelho do furo corrigido em 20260828080000: la o caso quitado nao SAIA da fila;
-- aqui o caso que saiu por "sem saldo" nao VOLTA quando a divida reaparece.
--
-- Existe reabertura automatica para parcela de acordo (trg_reabrir_aluno_divida_nova_*)
-- e para titulo incluido (trg_reabrir_quitado_titulo), mas ela nao cobre mensalidade que
-- volta a ficar ABERTO depois. Resultado: 25 casos fora da base devendo R$ 67.186,55.
--
-- NAO mexe em encerramento de gestao (juridico / cancelamento / suspensao): esses saem
-- por decisao, nao por saldo.

create or replace function public.casos_reabrir_com_divida(p_limite integer default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $$
declare
  v_bloq text[] := array['JURIDICO','CANCELAMENTO COBRANCA','SUSPENSAO COBRANCA',
                         'SUSPENSAO DE COBRANCA','CANCELADO'];
  v_n integer := 0;
  r record;
begin
  for r in
    select c.id, c.aluno_id, c.status_atual as st_ant
      from public.casos c
     where c.aluno_id is not null
       -- ja fora da base, OU a regra diz encerrado mesmo com a marca ainda ligada
       and (coalesce(c.encerrado_operacional, false)
            or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                 c.status_financeiro, c.status_jornada))
       and public.normalizar_status_acionamento(coalesce(c.status_atual,''))       <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_acionamento,'')) <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_financeiro,''))  <> all(v_bloq)
       and public.normalizar_status_acionamento(coalesce(c.status_jornada,''))     <> all(v_bloq)
       -- "cobranca cancelada" escrito de qualquer jeito tambem fica de fora: e decisao da gestao
       and upper(coalesce(c.status_atual,'')) !~ 'CANCEL'
       and not exists (select 1 from public.alunos al
                        where al.id = c.aluno_id
                          and upper(coalesce(al.status_atual,'')) ~ 'JURIDICO|CANCELAMENTO|SUSPENSAO')
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric > 0.005
     limit coalesce(p_limite, 100000)
  loop
    update public.casos
       set status_atual = 'Em cobrança',
           status_acionamento = null,
           status_jornada = 'Em cobrança',
           caso_atualizado_por = 'sistema_reabrir_com_divida',
           caso_atualizado_em = now()
     where id = r.id;

    update public.alunos
       set status_atual = 'Em cobrança',
           status_jornada = 'Em cobrança',
           status_acionamento = null
     where id = r.aluno_id
       and upper(coalesce(status_atual,'')) !~ 'JURIDICO|CANCELAMENTO|SUSPENSAO';

    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_anterior, status_novo,
       registrado_por_nome, registrado_por_email, registrado_em)
    values (r.aluno_id::text, 'REABERTURA_DIVIDA_NOVA',
            'Caso estava fora da base como "' || coalesce(r.st_ant,'(sem status)')
            || '" mas voltou a ter saldo em aberto. Devolvido para a fila.',
            coalesce(r.st_ant,'(sem)'), 'Em cobrança',
            'Sistema', 'sistema_reabrir_com_divida', now());

    perform public.recalcular_situacao_aluno(r.aluno_id, 'reabrir_com_divida');
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function public.casos_reabrir_com_divida(integer) from public, anon, authenticated;
grant execute on function public.casos_reabrir_com_divida(integer) to service_role;

select cron.schedule('casos_reabrir_com_divida_horario', '35 * * * *',
                     'select public.casos_reabrir_com_divida();');
