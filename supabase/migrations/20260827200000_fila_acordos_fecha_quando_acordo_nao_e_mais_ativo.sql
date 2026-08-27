-- Fila de acordos nao pode cobrar confirmacao de acordo morto.
--
-- Amanda, 27/08/2026: "marcus vinicius freitas fontoura na fila de confirmacao
-- aparece que tem dois acordos mas o aluno tem apenas 1". Depois: "tire as
-- linhas fantasmas, estao distorcendo os valores".
--
-- Ela estava certa. Marcus Vinicius Freitas Fontana tem DOIS acordos na base,
-- mas so um vivo:
--     nº 1481, de 20/07, R$ 1.142,13  -> CANCELADO
--     nº 3337, de 12/08, R$ 1.773,87  -> ATIVO
--
-- A fila mostrava os dois, porque nunca soube que o primeiro morreu: a linha
-- nasce na importacao e so sai quando ALGUEM confirma. Cancelar o acordo nao
-- mexia nela.
--
-- ESCALA: 124 linhas pendentes cujo acordo ja estava encerrado, R$ 183.319,31.
-- Cada uma e uma conferencia que nunca precisou existir -- e faz o operador
-- achar que o aluno tem mais acordo do que tem.
--
-- COMO CASA a linha com o acordo. `fila_acordos_confirmar.acordo_id` so esta
-- preenchido em 160 das 1.795 pendentes, entao nao da para depender dele. O
-- criterio de reserva e o mesmo que a importacao usa para nao duplicar: mesmo
-- aluno + mesmo valor_total. So fecha quando NAO EXISTE nenhum acordo ATIVO
-- daquele aluno com aquele valor -- se existir, a linha continua de pe.
--
-- Status novo: ENCERRADO_SEM_ACORDO_ATIVO, ao lado de ENCERRADO_SEM_SALDO que
-- ja existia para o caso irmao.
--
-- RESULTADO da limpeza: 111 linhas fechadas, R$ 128.274,45. A fila caiu de
-- 1.795 para 1.684.

create or replace function public._fila_acordo_fecha_ao_encerrar_acordo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- So interessa quando o acordo DEIXA de ser ativo.
  if upper(coalesce(new.status,'')) = 'ATIVO' or upper(coalesce(old.status,'')) <> 'ATIVO' then
    return null;
  end if;
  if new.aluno_id is null then
    return null;
  end if;

  update public.fila_acordos_confirmar f
     set status_confirmacao = 'ENCERRADO_SEM_ACORDO_ATIVO',
         confirmado_em = coalesce(f.confirmado_em, now()),
         observacao = coalesce(nullif(btrim(f.observacao),''),
           'Fechada automaticamente: o acordo correspondente foi encerrado. Nao ha o que confirmar.')
   where f.confirmado_em is null
     and coalesce(f.status_confirmacao,'A_CONFIRMAR') = 'A_CONFIRMAR'
     and (
       f.acordo_id = new.id
       or (f.acordo_id is null
           and f.aluno_id = new.aluno_id
           and round(coalesce(f.valor_total,0),2) = round(coalesce(new.valor_total,0),2))
     )
     -- Guarda: se ainda existe acordo ATIVO com esse valor, ha o que confirmar.
     and not exists (
       select 1 from public.acordos a
        where a.aluno_id = new.aluno_id
          and a.status = 'ATIVO'
          and round(coalesce(a.valor_total,0),2) = round(coalesce(f.valor_total,0),2)
     );

  return null;
end;
$function$;

drop trigger if exists trg_fila_acordo_fecha_ao_encerrar on public.acordos;
create trigger trg_fila_acordo_fecha_ao_encerrar
after update of status on public.acordos
for each row execute function public._fila_acordo_fecha_ao_encerrar_acordo();

-- Limpeza do que ja estava preso (111 linhas em 27/08/2026).
update public.fila_acordos_confirmar f
   set status_confirmacao = 'ENCERRADO_SEM_ACORDO_ATIVO',
       confirmado_em = coalesce(f.confirmado_em, now()),
       observacao = coalesce(nullif(btrim(f.observacao),''),
         'Fechada automaticamente: o acordo correspondente foi encerrado. Nao ha o que confirmar.')
 where f.confirmado_em is null
   and coalesce(f.status_confirmacao,'A_CONFIRMAR') = 'A_CONFIRMAR'
   and f.aluno_id is not null
   and not exists (
     select 1 from public.acordos a
      where a.aluno_id = f.aluno_id and a.status = 'ATIVO'
        and round(coalesce(a.valor_total,0),2) = round(coalesce(f.valor_total,0),2))
   and exists (
     select 1 from public.acordos a
      where a.aluno_id = f.aluno_id and a.status <> 'ATIVO'
        and round(coalesce(a.valor_total,0),2) = round(coalesce(f.valor_total,0),2));
