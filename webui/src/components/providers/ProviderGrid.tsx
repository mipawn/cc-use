import { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { Spin } from 'antd';
import type { Provider } from '../../api/client';
import { useProvidersStore } from '../../stores/providers';
import { useUIStore } from '../../stores/ui';
import ProviderCard from './ProviderCard';
import AddCard from './AddCard';
import UsageStatsModal from './UsageStatsModal';

interface ProviderGridProps {
  providers: Provider[];
  loading: boolean;
}

export default function ProviderGrid({ providers, loading }: ProviderGridProps) {
  const { reorderProviders } = useProvidersStore();
  const { openDrawer } = useUIStore();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statsProvider, setStatsProvider] = useState<Provider | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);

    if (over && active.id !== over.id) {
      const activeIdStr = String(active.id);
      const overIdStr = String(over.id);
      const oldIndex = providers.findIndex((p) => p.id === activeIdStr);
      const newIndex = providers.findIndex((p) => p.id === overIdStr);

      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(providers, oldIndex, newIndex);
        reorderProviders(newOrder.map((p) => p.id));
      }
    }
  };

  const activeProvider = activeId ? providers.find((p) => p.id === activeId) : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Spin size="large" />
      </div>
    );
  }

  if (providers.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        <AddCard onClick={() => openDrawer()} />
      </div>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={providers.map((p) => p.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                isDragging={activeId === provider.id}
                onShowStats={setStatsProvider}
              />
            ))}
            <AddCard onClick={() => openDrawer()} />
          </div>
        </SortableContext>

        {/* Drag Overlay - shows the dragged item */}
        <DragOverlay adjustScale={false}>
          {activeProvider ? (
            <div className="opacity-90 rotate-2 scale-105">
              <ProviderCard provider={activeProvider} isOverlay />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Usage Stats Modal */}
      <UsageStatsModal
        provider={statsProvider}
        onClose={() => setStatsProvider(null)}
      />
    </>
  );
}
