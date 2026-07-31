-- ============================================================================
-- DEVOLVER OPERADOR AO REJEITAR CONFIRMAÇÃO
-- ----------------------------------------------------------------------------
-- Casos baixados-via-link foram MOVIDOS para a confirmação (operador removido,
-- saem da fila e da CONTAGEM da carteira). Se a confirmação for REJEITADA, o
-- caso deve VOLTAR ao operador original.
--
--   * calibragem_dono_anterior_confirmacao: mapa aluno -> operador original
--   * trigger em solicitacoes_confirmacao_pagamento: ao virar PAGAMENTO_REJEITADO,
--     restaura o operador (se o caso estiver sem dono) e consome o mapeamento.
-- Reversível.
-- ============================================================================

begin;

create table if not exists public.calibragem_dono_anterior_confirmacao (
  aluno_id       text primary key,
  operador_email text not null,
  operador_nome  text,
  operador_upper text,
  motivo         text,
  criado_em      timestamptz not null default now()
);
alter table public.calibragem_dono_anterior_confirmacao enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename='calibragem_dono_anterior_confirmacao' and policyname='cdac_sel') then
    create policy cdac_sel on public.calibragem_dono_anterior_confirmacao for select to authenticated using (public.calibragem_e_gestao());
  end if;
end $$;

create or replace function public.devolver_operador_ao_rejeitar_confirmacao()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if upper(coalesce(NEW.status,'')) = 'PAGAMENTO_REJEITADO'
     and upper(coalesce(OLD.status,'')) is distinct from 'PAGAMENTO_REJEITADO'
     and NEW.aluno_id is not null then
    -- devolve o operador original apenas se o caso estiver sem dono
    update public.casos c
       set operador_email = m.operador_email,
           operador_nome  = m.operador_nome,
           operador       = coalesce(m.operador_upper, upper(m.operador_nome))
      from public.calibragem_dono_anterior_confirmacao m
     where m.aluno_id = NEW.aluno_id::text
       and c.aluno_id::text = NEW.aluno_id::text
       and c.operador_email is null;
    -- consome o mapeamento (one-shot)
    delete from public.calibragem_dono_anterior_confirmacao where aluno_id = NEW.aluno_id::text;
  end if;
  return NEW;
end;
$$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname='trg_devolver_operador_ao_rejeitar') then
    create trigger trg_devolver_operador_ao_rejeitar
      after update on public.solicitacoes_confirmacao_pagamento
      for each row execute function public.devolver_operador_ao_rejeitar_confirmacao();
  end if;
end $$;

commit;
