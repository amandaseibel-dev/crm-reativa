-- Na importacao, duplicidade e AVISO -- nao e parede.
--
-- Amanda, 27/08/2026: "acordo duplicado, na importacao de acordo, o sistema
-- deveria sinalizar as duplicidades e importar normalmente".
--
-- COMO ERA. A trava tg_acordo_bloquear_duplicado levanta excecao. Isso e certo
-- quando uma PESSOA lanca um acordo: ela esta ali, le o aviso e decide. Mas a
-- importacao insere os acordos num unico `insert ... select`, entao UMA linha
-- duplicada derrubava o COMANDO INTEIRO -- todos os acordos daquele lote
-- ficavam de fora, por causa de um. O arquivo vem da Prime e nao da para
-- editar antes; o resultado era importacao travada.
--
-- COMO FICA. A trava passa a distinguir quem esta inserindo:
--
--   pessoa      -> continua barrando, com a mesma mensagem (nada muda)
--   importacao  -> deixa entrar e MARCA: acordos.duplicado_de aponta para o
--                  acordo ATIVO que ja existia
--
-- A marca e o que a Amanda pediu como "sinalizar": o acordo entra, mas fica
-- apontado, e da para listar todos e decidir um a um -- sem que ninguem
-- descubra a duplicidade so quando o aluno reclamar.
--
-- A chave de duplicidade e a mesma de sempre: mesmo aluno + mesmo valor_total +
-- mesma qtd_parcelas, ambos ATIVOS.
--
-- O sinal so vale dentro da transacao da importacao (set_config com is_local =
-- true), entao nao ha como ligar por fora e furar a trava. Conferido nos dois
-- caminhos antes de subir: pessoa BARROU, importacao ENTROU E MARCOU.

alter table public.acordos
  add column if not exists duplicado_de uuid references public.acordos(id) on delete set null,
  add column if not exists duplicado_marcado_em timestamptz;

create index if not exists acordos_duplicado_de_idx
  on public.acordos (duplicado_de) where duplicado_de is not null;

comment on column public.acordos.duplicado_de is
  'Preenchido pela IMPORTACAO quando o acordo entrou apesar de ja existir outro ATIVO igual (mesmo aluno, valor e parcelas). Aponta para o acordo que ja existia. Lancamento manual continua sendo barrado, nao marcado.';

create or replace function public.tg_acordo_bloquear_duplicado()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existente public.acordos%rowtype;
  v_precisa_conferir boolean;
  v_importando boolean;
begin
  if coalesce(new.status,'') <> 'ATIVO' or new.aluno_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    v_precisa_conferir := true;
  else
    -- So interessa quando a linha PASSA a ser uma copia: mudou a chave, ou um
    -- acordo encerrado voltou a ficar ativo. Reescrever o mesmo valor nao cria
    -- duplicacao nenhuma e nao pode barrar o trabalho.
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

  if not found then
    return new;
  end if;

  -- Importacao: sinaliza e deixa passar. So a propria importar_acordos liga
  -- este sinal, e so dentro da transacao dela.
  v_importando := coalesce(current_setting('reativa.importando', true), '') = 'on';

  if v_importando then
    new.duplicado_de := v_existente.id;
    new.duplicado_marcado_em := now();
    return new;
  end if;

  raise exception
    'ACORDO_DUPLICADO: este aluno já tem um acordo ATIVO de % em %x (acordo nº %, criado em %). Se o novo substitui o antigo, cancele o antigo primeiro; se são acordos diferentes, confira valor e parcelas.',
    to_char(coalesce(new.valor_total,0),'FM999G999G990D00'),
    coalesce(new.qtd_parcelas,0),
    coalesce(v_existente.numero_acordo::text,'sem número'),
    to_char(v_existente.criado_em,'DD/MM/YYYY')
    using errcode = '23505';
end;
$function$;
