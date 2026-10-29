-- Impedir dois acordos ATIVOS iguais para o mesmo aluno.
--
-- O QUE ESTAVA ACONTECENDO (medido em 26/08/2026): 97 grupos duplicados, 104
-- acordos a mais, R$ 341.377 de divida contada em dobro -- e dois grupos novos
-- so na ultima semana. Nos ATIVOS, que sao os que inflam carteira, projecao e
-- meta do operador: R$ 308.258 duplicados.
--
-- POR QUE A TRAVA QUE JA EXISTIA NAO PEGOU: ela vigia a IMPORTACAO. Mas dos 104
-- ativos duplicados, 88 nasceram NA MAO -- alguem abre a ficha, nao ve que o
-- acordo ja esta la (ou outra pessoa acabou de lancar) e lanca de novo. O
-- caminho manual passava por fora.
--
-- Por isso esta trava mora no BANCO, como trigger: vale para a tela, para a
-- importacao, para RPC e para qualquer caminho que alguem escreva depois.
--
-- CRITERIO: mesmo aluno + mesmo valor_total + mesma qtd de parcelas, ambos
-- ATIVOS. Dois acordos vivos identicos para a mesma pessoa e, na pratica,
-- sempre erro de lancamento -- foi assim nos 97 grupos encontrados.
--
-- O QUE NAO BLOQUEIA, de proposito (testado):
--   - acordo CANCELADO ou QUITADO com os mesmos valores (renegociacao e normal);
--   - valores ou parcelas diferentes (acordo novo de verdade);
--   - aluno sem id (nao ha como comparar).
--
-- A mensagem traz o numero do acordo que ja existe e a data, para quem lancou
-- achar o caso em vez de adivinhar o que deu errado.

create or replace function public.tg_acordo_bloquear_duplicado()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_existente public.acordos%rowtype;
begin
  if coalesce(new.status,'') <> 'ATIVO' or new.aluno_id is null then
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

drop trigger if exists trg_acordo_bloquear_duplicado on public.acordos;

create trigger trg_acordo_bloquear_duplicado
  before insert or update of status, valor_total, qtd_parcelas, aluno_id
  on public.acordos
  for each row
  execute function public.tg_acordo_bloquear_duplicado();

comment on function public.tg_acordo_bloquear_duplicado() is
  'Recusa segundo acordo ATIVO com mesmo aluno + valor + qtd de parcelas. Mora no banco porque 88 dos 104 duplicados ativos nasceram do cadastro manual, que passava por fora da trava da importacao.';
