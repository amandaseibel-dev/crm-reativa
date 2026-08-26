-- Rollback: volta a versão que confere em todo UPDATE.
--
-- ATENÇÃO: isso reintroduz o bug -- vincular parcela, recalcular saldo e
-- qualquer escrita em qtd_parcelas/valor_total voltam a dar ACORDO_DUPLICADO
-- nos alunos que já têm acordo repetido, que são justamente os que precisam
-- ser consertados.
create or replace function public.tg_acordo_bloquear_duplicado()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare v_existente public.acordos%rowtype;
begin
  if coalesce(new.status,'') <> 'ATIVO' or new.aluno_id is null then return new; end if;
  select * into v_existente from public.acordos
  where aluno_id = new.aluno_id and status = 'ATIVO'
    and coalesce(valor_total,0) = coalesce(new.valor_total,0)
    and coalesce(qtd_parcelas,0) = coalesce(new.qtd_parcelas,0)
    and id <> new.id limit 1;
  if found then
    raise exception 'ACORDO_DUPLICADO: este aluno já tem um acordo ATIVO de % em %x (acordo nº %, criado em %).',
      to_char(coalesce(new.valor_total,0),'FM999G999G990D00'), coalesce(new.qtd_parcelas,0),
      coalesce(v_existente.numero_acordo::text,'sem número'),
      to_char(v_existente.criado_em,'DD/MM/YYYY') using errcode = '23505';
  end if;
  return new;
end;
$$;
