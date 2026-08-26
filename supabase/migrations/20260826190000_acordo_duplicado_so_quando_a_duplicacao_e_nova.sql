-- A trava de duplicado estava travando o conserto do duplicado.
--
-- O QUE QUEBROU (26/08/2026, mesmo dia em que a trava subiu): vincular parcelas
-- passou a dar erro. A causa é a trava, e o erro é meu.
--
-- Ela roda em `before insert or update of status, valor_total, qtd_parcelas,
-- aluno_id`. Só que UPDATE dispara quando a coluna é ESCRITA, não quando ela
-- MUDA. Vincular parcela reescreve qtd_parcelas com o mesmo número -- e, num
-- aluno que já tem dois acordos iguais, a trava olhava o estado atual, achava o
-- gêmeo (que já estava lá antes) e recusava.
--
-- O efeito perverso: justamente os alunos com acordo duplicado, que são os que
-- precisam de conserto, ficavam impossíveis de mexer.
--
-- A CORREÇÃO: a trava passa a perguntar se a DUPLICAÇÃO É NOVA.
--
--   INSERT de acordo ATIVO                        -> confere (é duplicação nova)
--   UPDATE que muda aluno, valor ou qtd parcelas  -> confere (pode virar cópia)
--   UPDATE que reativa um acordo encerrado        -> confere (volta a ser cópia)
--   UPDATE que não mexe em nada disso             -> passa direto
--
-- Continua impossível CRIAR uma cópia, e volta a ser possível trabalhar nas
-- cópias que já existem: vincular parcela, recalcular saldo, cancelar a que
-- sobra. Provado em produção nos seis casos, sem deixar linha de teste.

create or replace function public.tg_acordo_bloquear_duplicado()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existente public.acordos%rowtype;
  v_precisa_conferir boolean;
begin
  if coalesce(new.status,'') <> 'ATIVO' or new.aluno_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_precisa_conferir := true;
  else
    -- Só interessa quando a linha PASSA a ser uma cópia: mudou a chave, ou um
    -- acordo encerrado voltou a ficar ativo. Reescrever o mesmo valor não cria
    -- duplicação nenhuma e não pode barrar o trabalho.
    v_precisa_conferir :=
         coalesce(old.status,'') <> 'ATIVO'
      or old.aluno_id     is distinct from new.aluno_id
      or old.valor_total  is distinct from new.valor_total
      or old.qtd_parcelas is distinct from new.qtd_parcelas;
  end if;

  if not v_precisa_conferir then
    return new;
  end if;

  select * into v_existente
  from public.acordos
  where aluno_id = new.aluno_id
    and status = 'ATIVO'
    and coalesce(valor_total,0) = coalesce(new.valor_total,0)
    and coalesce(qtd_parcelas,0) = coalesce(new.qtd_parcelas,0)
    and id <> new.id
  limit 1;

  if found then
    raise exception
      'ACORDO_DUPLICADO: este aluno já tem um acordo ATIVO de % em %x (acordo nº %, criado em %). Se o novo substitui o antigo, cancele o antigo primeiro; se são acordos diferentes, confira valor e parcelas.',
      to_char(coalesce(new.valor_total,0),'FM999G999G990D00'),
      coalesce(new.qtd_parcelas,0),
      coalesce(v_existente.numero_acordo::text,'sem número'),
      to_char(v_existente.criado_em,'DD/MM/YYYY')
      using errcode = '23505';
  end if;

  return new;
end;
$$;

comment on function public.tg_acordo_bloquear_duplicado() is
  'Recusa a CRIACAO de um segundo acordo ATIVO com mesmo aluno + valor + qtd de parcelas. Em UPDATE so confere quando a duplicacao seria NOVA (mudou aluno/valor/parcelas, ou o acordo foi reativado) -- reescrever o mesmo valor passa direto, senao os alunos com duplicado ficavam impossiveis de consertar.';
