-- Volta ao comportamento anterior: devolve so o operador, nao o status.
create or replace function public.devolver_operador_ao_rejeitar_confirmacao()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  if upper(coalesce(NEW.status,'')) = 'PAGAMENTO_REJEITADO'
     and upper(coalesce(OLD.status,'')) is distinct from 'PAGAMENTO_REJEITADO'
     and NEW.aluno_id is not null then
    update public.casos c set operador_email=m.operador_email, operador_nome=m.operador_nome,
           operador=coalesce(m.operador_upper, upper(m.operador_nome))
      from public.calibragem_dono_anterior_confirmacao m
     where m.aluno_id=NEW.aluno_id::text and c.aluno_id::text=NEW.aluno_id::text and c.operador_email is null;
    delete from public.calibragem_dono_anterior_confirmacao where aluno_id=NEW.aluno_id::text;
  end if;
  return NEW;
end;
$function$;
