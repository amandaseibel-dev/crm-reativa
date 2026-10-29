-- Quem quitou terminando um acordo também sai da fila.
--
-- O FURO. `casos_reavaliar_encerramento` fecha o caso quando o saldo é zero E
-- (a regra `caso_encerrado_operacional` diz encerrado OU o status do ALUNO bate
-- com `QUIT|BAIXA|SALDO_ZERO|SEM_SALDO`). Em 02/09/2026 havia 11 casos com
-- `situacao_operacional = QUITADO`, saldo zero e AINDA ABERTOS -- um deles há
-- seis semanas na carteira do cobranca03 (caso 9624, quitado em 21/07). Nove
-- tinham o aluno com `status_atual = ACORDO_FECHADO`, palavra fora do padrão.
--
-- POR QUE NÃO BASTOU ACRESCENTAR "ACORDO_FECHADO" AO PADRÃO, e isso importa:
-- "acordo fechado" quer dizer acordo FIRMADO, não pago. São 593 alunos com esse
-- status e 577 deles AINDA DEVEM, R$ 2.486.988,04 no total. Colocar a palavra
-- num padrão de quitação daria a entender o contrário para quem lesse depois.
--
-- `situacao_operacional` é melhor porque não é string herdada: é o que
-- `recalcular_situacao_aluno` calculou a partir do saldo real. E a trava de
-- saldo zero continua valendo por cima de tudo.
create or replace function public.casos_reavaliar_encerramento(p_limite integer default null::integer)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
 set statement_timeout to '180s'
as $function$
declare v_n integer;
begin
  with alvo as (
    select c.id
      from public.casos c
      join public.alunos al on al.id = c.aluno_id
     where not coalesce(c.encerrado_operacional, false)
       and c.aluno_id is not null
       -- trava que nao muda: so fecha quem NAO deve nada
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric <= 0.005
       and (
         public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                           c.status_financeiro, c.status_jornada)
         or upper(coalesce(al.status_atual,'')) ~ 'QUIT|BAIXA|SALDO_ZERO|SEM_SALDO'
         or upper(coalesce(c.situacao_operacional,'')) = 'QUITADO'
       )
     limit coalesce(p_limite, 100000)
  )
  update public.casos c
     set encerrado_operacional = true,
         caso_atualizado_por = 'sistema_reavaliar_encerramento',
         caso_atualizado_em = now()
    from alvo a
   where c.id = a.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
