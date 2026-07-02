class RubyWorker
  def perform(value)
    value.to_s
  end
end

def top_level_task(input)
  input.reverse
end
