-- Rollback: a trava volta a BARRAR tambem na importacao (um duplicado derruba o lote).
-- A coluna duplicado_de fica -- ela e registro do que ja foi sinalizado.
create or replace function public.tg_acordo_bloquear_duplicado()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare v_existente public.acordos%rowtype; v_precisa_conferir boolean;
begin
  if coalesce(new.status,'') <> 'ATIVO' or new.aluno_id is null then return new; end if;
  if tg_op = 'INSERT' then v_precisa_conferir := true;
  else v_precisa_conferir := coalesce(old.status,'') <> 'ATIVO'
      or old.aluno_id is distinct from new.aluno_id
      or old.valor_total is distinct from new.valor_total
      or old.qtd_parcelas is distinct from new.qtd_parcelas;
  end if;
  if not v_precisa_conferir then return new; end if;
  select * into v_existente from public.acordos
  where aluno_id = new.aluno_id and status = 'ATIVO'
    and coalesce(valor_total,0) = coalesce(new.valor_total,0)
    and coalesce(qtd_parcelas,0) = coalesce(new.qtd_parcelas,0) and id <> new.id limit 1;
  if found then
    raise exception 'ACORDO_DUPLICADO: este aluno já tem um acordo ATIVO de % em %x (acordo nº %, criado em %).',
      to_char(coalesce(new.valor_total,0),'FM999G999G990D00'), coalesce(new.qtd_parcelas,0),
      coalesce(v_existente.numero_acordo::text,'sem número'), to_char(v_existente.criado_em,'DD/MM/YYYY')
      using errcode = '23505';
  end if;
  return new;
end; $function$;
